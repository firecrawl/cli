import { spawn, spawnSync, type StdioOptions } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import packageJson from '../../package.json';
import {
  detectInstallChannel,
  isCompiledBinary,
  type InstallChannel,
} from './install-channel';
import { compareVersions, getLatestVersion } from './npm-registry';
import {
  getCachePath,
  readCachedLatest,
  updateCommand,
  writeCachedLatest,
} from './update-notice';

const STATE_FILE = 'auto-update.json';
const LOCK_FILE = 'auto-update.lock';
const LOG_FILE = 'auto-update.log';
const WORKER_ENV = 'FIRECRAWL_AUTO_UPDATE_WORKER';
const RELEASES_URL = 'https://github.com/firecrawl/cli/releases/download';
const LOCK_STALE_MS = 45 * 60 * 1000;
const PARENT_WAIT_MS = 30 * 60 * 1000;
const CHECK_RETRY_MS = 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const LOG_MAX_BYTES = 256 * 1024;

const CHANNEL_LABELS = {
  npm: 'npm',
  pnpm: 'pnpm',
  bun: 'bun',
  yarn: 'yarn',
  brew: 'Homebrew',
  binary: 'the GitHub release binary',
} as const;

interface AutoUpdateState {
  disabled?: boolean;
  retryAt?: string;
  lastError?: string;
  updated?: { from: string; to: string; at: string; announced?: boolean };
}

type UpdatableChannel = Exclude<InstallChannel, { kind: 'unsupported' }>;
type Log = (message: string) => void;

function firecrawlDir(): string {
  return path.join(os.homedir(), '.firecrawl');
}

function readState(dir: string): AutoUpdateState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')
    );
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(dir: string, patch: Partial<AutoUpdateState>): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const next = { ...readState(dir), ...patch };
    fs.writeFileSync(path.join(dir, STATE_FILE), `${JSON.stringify(next)}\n`);
    return true;
  } catch {
    return false;
  }
}

function enabledFlag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true';
}

/** Why automatic updates are off, or undefined when they are on. */
export function autoUpdateBlocker(
  state: AutoUpdateState = readState(firecrawlDir())
): string | undefined {
  if (enabledFlag('FIRECRAWL_NO_UPDATE_CHECK')) {
    return 'FIRECRAWL_NO_UPDATE_CHECK is set';
  }
  if (enabledFlag('FIRECRAWL_NO_AUTO_UPDATE')) {
    return 'FIRECRAWL_NO_AUTO_UPDATE is set';
  }
  const ci = process.env.CI?.toLowerCase();
  if (ci && ci !== '0' && ci !== 'false') return 'CI is set';
  if (state.disabled) return 'they are turned off with --disable-auto';
  return undefined;
}

export function setAutoUpdateEnabled(enabled: boolean): boolean {
  return writeState(firecrawlDir(), { disabled: enabled ? undefined : true });
}

function sameMajor(a: string, b: string): boolean {
  const major = (v: string) => parseInt(v.replace(/^v/, ''), 10);
  return major(a) === major(b);
}

function lockHeld(dir: string): boolean {
  try {
    const age = Date.now() - fs.statSync(path.join(dir, LOCK_FILE)).mtimeMs;
    return age < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function acquireLock(dir: string): (() => void) | null {
  const lockPath = path.join(dir, LOCK_FILE);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(lockPath, { force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' || lockHeld(dir)) return null;
      fs.rmSync(lockPath, { force: true });
    }
  }
  return null;
}

function openLog(dir: string): { fd: number; log: Log } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOG_FILE);
  try {
    if (fs.statSync(file).size > LOG_MAX_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    // No log yet.
  }
  const fd = fs.openSync(file, 'a');
  return {
    fd,
    log: (message) =>
      fs.writeSync(fd, `[${new Date().toISOString()}] ${message}\n`),
  };
}

function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env[WORKER_ENV];
  return env;
}

/** Resolves to an error message, or undefined when the command succeeded. */
function run(
  command: string,
  args: string[],
  stdio: StdioOptions,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const shell =
      process.platform === 'win32' && ['npm', 'pnpm', 'yarn'].includes(command);
    const child = spawn(shell ? `${command}.cmd` : command, args, {
      stdio,
      env: options.env ?? childEnv(),
      cwd: options.cwd,
      shell,
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve(`${command}: ${error.message}`);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(
        code === 0
          ? undefined
          : `${command} ${args.join(' ')} exited with ${code ?? signal}`
      );
    });
  });
}

function verifyPackage(
  packageRoot: string,
  version: string
): string | undefined {
  let found: string | undefined;
  try {
    found = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
    ).version;
  } catch {
    found = undefined;
  }
  return found === version
    ? undefined
    : `expected ${version} in ${packageRoot}, found ${found ?? 'nothing'}`;
}

/** pnpm 11+ moves each global install into a new hashed directory beside the old one. */
function verifyPnpm(packageRoot: string, version: string): string | undefined {
  const error = verifyPackage(packageRoot, version);
  if (!error) return undefined;
  const globalDir = path.dirname(path.dirname(path.dirname(packageRoot)));
  try {
    const found = fs
      .readdirSync(globalDir)
      .some(
        (entry) =>
          !verifyPackage(
            path.join(globalDir, entry, 'node_modules', 'firecrawl-cli'),
            version
          )
      );
    return found ? undefined : error;
  } catch {
    return error;
  }
}

function verifyKeg(cellar: string, version: string): string | undefined {
  const kegs = fs.readdirSync(cellar);
  return kegs.some((keg) => keg === version || keg.startsWith(`${version}_`))
    ? undefined
    : `Homebrew does not offer ${version} yet`;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Download, verify, and atomically swap in the release binary. */
async function replaceBinary(
  channel: Extract<InstallChannel, { kind: 'binary' }>,
  version: string,
  log: Log
): Promise<string | undefined> {
  const releases = (process.env.FIRECRAWL_RELEASES_URL || RELEASES_URL).replace(
    /\/+$/,
    ''
  );
  const base = `${releases}/v${version}`;
  const archive = `${channel.asset}.tar.gz`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-update-'));
  const staged = path.join(
    path.dirname(channel.executable),
    `.firecrawl-update-${process.pid}`
  );
  try {
    log(`Downloading ${base}/${archive}`);
    const [tarball, checksums] = await Promise.all([
      download(`${base}/${archive}`),
      download(`${base}/checksums.txt`),
    ]);
    const expected = checksums
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(([, name]) => name?.replace(/^\*/, '') === archive)?.[0];
    if (!expected) return `checksums.txt has no entry for ${archive}`;
    const actual = createHash('sha256').update(tarball).digest('hex');
    if (actual !== expected.toLowerCase()) {
      return `checksum mismatch for ${archive}`;
    }
    log('Checksum verified');

    fs.writeFileSync(path.join(tmp, archive), tarball);
    const untarError = await run('tar', ['-xzf', archive], 'ignore', {
      cwd: tmp,
    });
    if (untarError) return untarError;

    const extracted = path.join(tmp, channel.asset);
    const probe = spawnSync(extracted, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: childEnv({ FIRECRAWL_NO_UPDATE_CHECK: '1' }),
    });
    const reported = probe.stdout?.trim();
    if (reported !== version) {
      return `downloaded binary reported ${reported || probe.error?.message || 'nothing'}, expected ${version}`;
    }

    fs.copyFileSync(extracted, staged);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, channel.executable);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    fs.rmSync(staged, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function installVersion(
  channel: UpdatableChannel,
  version: string,
  stdio: StdioOptions,
  log: Log
): Promise<string | undefined> {
  const spec = `firecrawl-cli@${version}`;
  switch (channel.kind) {
    case 'npm':
      return (
        (await run('npm', ['install', '-g', spec], stdio, {
          env: childEnv({ npm_config_prefix: channel.prefix }),
        })) ?? verifyPackage(channel.packageRoot, version)
      );
    case 'pnpm':
      return (
        (await run('pnpm', ['add', '-g', spec], stdio)) ??
        verifyPnpm(channel.packageRoot, version)
      );
    case 'bun':
      return (
        (await run('bun', ['add', '-g', spec], stdio)) ??
        verifyPackage(channel.packageRoot, version)
      );
    case 'yarn':
      return (
        (await run('yarn', ['global', 'add', spec], stdio)) ??
        verifyPackage(channel.packageRoot, version)
      );
    case 'brew':
      return (
        (await run('brew', ['upgrade', 'firecrawl-cli'], stdio)) ??
        verifyKeg(channel.cellar, version)
      );
    case 'binary':
      return replaceBinary(channel, version, log);
  }
}

function announceUpdate(
  dir: string,
  state: AutoUpdateState,
  stderr: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>
): void {
  const updated = state.updated;
  if (!updated || updated.announced || updated.to !== packageJson.version) {
    return;
  }
  if (!stderr.isTTY) return;
  stderr.write(
    `firecrawl updated itself from ${updated.from} to ${updated.to}. Turn off automatic updates with: firecrawl update --disable-auto\n`
  );
  writeState(dir, { updated: { ...updated, announced: true } });
}

export interface AutoUpdateOptions {
  channel?: InstallChannel;
  stderr?: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
}

/**
 * Starts a detached background update when one may be due and returns at once.
 * Resolves true when the updater owns this release, so the notice stays quiet.
 * Never writes to stdout.
 */
export async function startAutoUpdate(
  options: AutoUpdateOptions = {}
): Promise<boolean> {
  try {
    const dir = firecrawlDir();
    const state = readState(dir);
    announceUpdate(dir, state, options.stderr ?? process.stderr);
    if (autoUpdateBlocker(state)) return false;

    const channel = options.channel ?? detectInstallChannel();
    if (channel.kind === 'unsupported') return false;
    if (state.retryAt && Date.parse(state.retryAt) > Date.now()) return false;

    const current = packageJson.version;
    const cached = await readCachedLatest(getCachePath(), new Date());
    if (!cached.stale && cached.latestVersion) {
      if (compareVersions(current, cached.latestVersion) >= 0) return true;
      if (!sameMajor(current, cached.latestVersion)) return false;
    }
    if (lockHeld(dir)) return true;

    const compiled = isCompiledBinary();
    if (!compiled && !process.argv[1]) return false;
    const child = spawn(process.execPath, compiled ? [] : [process.argv[1]], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, [WORKER_ENV]: String(process.pid) },
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function isAutoUpdateWorker(): boolean {
  return Boolean(process.env[WORKER_ENV]);
}

async function waitForExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + PARENT_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * Body of the detached process startAutoUpdate spawns. Refreshes the version
 * cache, then installs a same-major release once the invoking command exits.
 */
export async function runAutoUpdateWorker(): Promise<void> {
  const dir = firecrawlDir();
  const parentPid = Number(process.env[WORKER_ENV]);
  let release: (() => void) | null = null;
  let logFd: number | undefined;
  try {
    release = acquireLock(dir);
    if (!release) return;
    const { fd, log } = openLog(dir);
    logFd = fd;
    if (autoUpdateBlocker()) return;
    const channel = detectInstallChannel();
    if (channel.kind === 'unsupported') return;

    const current = packageJson.version;
    const latest = await getLatestVersion(packageJson.name, 10_000);
    if (latest.unreachable || !latest.version) {
      log(`Version check failed: ${latest.error ?? 'no version returned'}`);
      writeState(dir, {
        retryAt: new Date(Date.now() + CHECK_RETRY_MS).toISOString(),
      });
      return;
    }
    const cachePath = getCachePath();
    const cached = await readCachedLatest(cachePath, new Date());
    await writeCachedLatest(cachePath, {
      latestVersion: latest.version,
      checkedAt: new Date().toISOString(),
      lastShownVersion: cached.lastShownVersion,
      lastShownAt: cached.lastShownAt,
    });

    if (compareVersions(current, latest.version) >= 0) return;
    if (!sameMajor(current, latest.version)) {
      log(`${latest.version} is a new major version; leaving it to the notice`);
      return;
    }
    if (parentPid > 0 && !(await waitForExit(parentPid))) {
      log('Invoking command is still running; retrying on a later run');
      return;
    }
    const now = new Date();
    fs.utimesSync(path.join(dir, LOCK_FILE), now, now);

    log(
      `Updating ${current} -> ${latest.version} with ${CHANNEL_LABELS[channel.kind]}`
    );
    const error = await installVersion(
      channel,
      latest.version,
      ['ignore', fd, fd],
      log
    );
    if (error) {
      log(`Update failed: ${error}`);
      writeState(dir, {
        retryAt: new Date(Date.now() + FAILURE_BACKOFF_MS).toISOString(),
        lastError: error,
      });
      return;
    }
    log(`Updated to ${latest.version}`);
    writeState(dir, {
      retryAt: undefined,
      lastError: undefined,
      updated: {
        from: current,
        to: latest.version,
        at: new Date().toISOString(),
      },
    });
  } catch (error) {
    writeState(dir, {
      retryAt: new Date(Date.now() + FAILURE_BACKOFF_MS).toISOString(),
      lastError: String(error),
    });
    if (logFd !== undefined) {
      fs.writeSync(logFd, `[${new Date().toISOString()}] ${String(error)}\n`);
    }
  } finally {
    release?.();
    if (logFd !== undefined) fs.closeSync(logFd);
  }
}

function manualUpdateHint(reason: string): string {
  if (reason === 'running through npx') {
    return 'Run npx -y firecrawl-cli@latest to use the latest version.';
  }
  if (reason === 'installed by a system package manager') {
    return 'Update it with the system package manager that installed it.';
  }
  if (isCompiledBinary()) {
    return 'Rerun the installer from https://docs.firecrawl.dev/cli to update.';
  }
  return `Update it the way it was installed, for example: ${updateCommand()}`;
}

/** Foreground update for `firecrawl update`. Resolves false on failure. */
export async function updateNow(): Promise<boolean> {
  const current = packageJson.version;
  const channel = detectInstallChannel();
  if (channel.kind === 'unsupported') {
    console.error(
      `firecrawl ${current} cannot update itself: ${channel.reason}.`
    );
    console.error(manualUpdateHint(channel.reason));
    return false;
  }

  const latest = await getLatestVersion(packageJson.name, 10_000);
  if (latest.unreachable || !latest.version) {
    console.error(
      `Could not check for updates: ${latest.error ?? 'no version returned'}`
    );
    return false;
  }
  if (compareVersions(current, latest.version) >= 0) {
    console.log(`firecrawl ${current} is up to date.`);
    return true;
  }

  const dir = firecrawlDir();
  const release = acquireLock(dir);
  if (!release) {
    console.error(
      'Another firecrawl update is in progress. Try again in a few minutes.'
    );
    return false;
  }
  try {
    console.log(
      `Updating firecrawl ${current} -> ${latest.version} with ${CHANNEL_LABELS[channel.kind]}...`
    );
    const error = await installVersion(
      channel,
      latest.version,
      'inherit',
      (message) => console.log(message)
    );
    if (error) {
      console.error(`Update failed: ${error}`);
      return false;
    }
    writeState(dir, {
      retryAt: undefined,
      lastError: undefined,
      updated: {
        from: current,
        to: latest.version,
        at: new Date().toISOString(),
        announced: true,
      },
    });
    console.log(`Updated firecrawl to ${latest.version}.`);
    return true;
  } finally {
    release();
  }
}
