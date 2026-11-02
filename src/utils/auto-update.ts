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
  type UnsupportedCode,
} from './install-channel';
import {
  compareVersions,
  getLatestVersion,
  isPrerelease,
  satisfiesRange,
} from './npm-registry';
import {
  envFlag,
  getCachePath,
  readCachedLatest,
  updateCheckDisabled,
  updateCommand,
  writeCachedLatest,
} from './update-notice';

const SETTINGS_FILE = 'auto-update.json';
const STATE_FILE = 'auto-update-state.json';
const LOCK_FILE = 'auto-update.lock';
const INSTALL_LOCK_FILE = 'auto-update-install.lock';
const LOG_FILE = 'auto-update.log';
const RUNNING_DIR = 'running';
const WORKER_ENV = 'FIRECRAWL_AUTO_UPDATE_WORKER';
const RELEASES_URL = 'https://github.com/firecrawl/cli/releases/download';
const LOCK_STALE_MS = 45 * 60 * 1000;
const IDLE_WAIT_MS = 30 * 60 * 1000;
const CHECK_RETRY_MS = 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
// Commands wait on package installs, so those get a tighter limit than downloads.
const PACKAGE_INSTALL_TIMEOUT_MS = 3 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
const LOG_MAX_BYTES = 256 * 1024;
const IN_PLACE = new Set(['npm', 'pnpm', 'bun', 'yarn']);
const AUTOMATIC = new Set([...IN_PLACE, 'binary']);

const CHANNEL_LABELS = {
  npm: 'npm',
  pnpm: 'pnpm',
  bun: 'bun',
  yarn: 'yarn',
  brew: 'Homebrew',
  binary: 'the GitHub release binary',
} as const;

interface AutoUpdateState {
  retryAt?: string;
  lastError?: string;
  updated?: { from: string; to: string; at: string; announced?: boolean };
}

type UpdatableChannel = Exclude<InstallChannel, { kind: 'unsupported' }>;
type Outcome =
  | { status: 'installed' }
  | { status: 'pending' | 'failed'; message: string };
type Log = (message: string) => void;

function firecrawlDir(): string {
  return path.join(os.homedir(), '.firecrawl');
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Writes through a rename so a concurrent reader never sees a partial file. */
function writeJson(file: string, data: object): boolean {
  const staged = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(staged, `${JSON.stringify(data)}\n`);
    fs.renameSync(staged, file);
    return true;
  } catch {
    fs.rm(staged, { force: true }, () => {});
    return false;
  }
}

function readState(dir: string): AutoUpdateState {
  return readJson(path.join(dir, STATE_FILE)) as AutoUpdateState;
}

function updateState(dir: string, patch: AutoUpdateState): void {
  writeJson(path.join(dir, STATE_FILE), { ...readState(dir), ...patch });
}

/** Why automatic updates are off, or undefined when they are on. */
export function autoUpdateBlocker(): string | undefined {
  if (updateCheckDisabled()) return 'FIRECRAWL_NO_UPDATE_CHECK is set';
  if (envFlag('FIRECRAWL_NO_AUTO_UPDATE')) {
    return 'FIRECRAWL_NO_AUTO_UPDATE is set';
  }
  const ci = process.env.CI?.toLowerCase();
  if (ci && ci !== '0' && ci !== 'false') return 'CI is set';
  if (readJson(path.join(firecrawlDir(), SETTINGS_FILE)).disabled) {
    return 'they are turned off with --disable-auto';
  }
  return undefined;
}

/** The user's choice lives in its own file, which the updater never writes. */
export function setAutoUpdateEnabled(enabled: boolean): boolean {
  return writeJson(
    path.join(firecrawlDir(), SETTINGS_FILE),
    enabled ? {} : { disabled: true }
  );
}

/** Homebrew stays on the notice: an unattended brew upgrade can update brew and other formulae. */
export function updatesAutomatically(channel: InstallChannel): boolean {
  return AUTOMATIC.has(channel.kind);
}

function sameMajor(a: string, b: string): boolean {
  const major = (v: string) => parseInt(v.replace(/^v/, ''), 10);
  return major(a) === major(b);
}

/**
 * A range this cannot read blocks only unattended installs; a foreground
 * install goes ahead and the package manager reports any engine problem.
 */
function engineMismatch(
  channel: UpdatableChannel,
  version: string,
  nodeRange: string | undefined,
  unattended: boolean
): string | undefined {
  if (!IN_PLACE.has(channel.kind) || !nodeRange) return undefined;
  const satisfied = satisfiesRange(process.versions.node, nodeRange);
  if (satisfied === true) return undefined;
  if (satisfied === undefined) {
    return unattended
      ? `firecrawl-cli ${version} declares engines.node "${nodeRange}", which the updater cannot read`
      : undefined;
  }
  return `firecrawl-cli ${version} requires Node ${nodeRange}, and this is Node ${process.versions.node}`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function runningDir(dir: string): string {
  return path.join(dir, RUNNING_DIR);
}

/**
 * Counts other live invocations and prunes the rest. An entry also needs a
 * recent heartbeat, since a killed process leaves its entry behind and its
 * pid can later belong to an unrelated process.
 */
export function otherInvocations(dir: string): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(runningDir(dir));
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const file = path.join(runningDir(dir), entry);
    let fresh = false;
    try {
      fresh = Date.now() - fs.statSync(file).mtimeMs < HEARTBEAT_STALE_MS;
    } catch {
      continue;
    }
    if (Number.isInteger(pid) && pid > 0 && fresh && isAlive(pid)) count++;
    else fs.rmSync(file, { force: true });
  }
  return count;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workerLockPath(dir: string): string {
  return path.join(dir, LOCK_FILE);
}

function installLockPath(dir: string): string {
  return path.join(dir, INSTALL_LOCK_FILE);
}

/** A lock is held while it is recent and the process that took it is alive. */
function lockHeld(file: string): boolean {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs >= LOCK_STALE_MS) return false;
  } catch {
    return false;
  }
  const pid = readJson(file).pid;
  return typeof pid !== 'number' || isAlive(pid);
}

function acquireLock(file: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), {
        flag: 'wx',
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      if (lockHeld(file)) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

function releaseLock(file: string): void {
  try {
    if (readJson(file).pid === process.pid) fs.rmSync(file, { force: true });
  } catch {
    // A stale lock expires on its own.
  }
}

let unregister: (() => void) | undefined;

/** Drops this process's running entry, before it exits or relaunches. */
export function unregisterInvocation(): void {
  unregister?.();
  unregister = undefined;
}

/**
 * Package installs are rewritten in place and commands load modules lazily.
 * Each invocation registers itself so an install waits for it, and waits
 * for an install that is already running before it continues. Resolves true
 * when an install finished while it waited: this process already loaded the
 * old release, so the caller should relaunch on the new one.
 */
export async function registerInvocation(
  channel: InstallChannel,
  stderr: Pick<NodeJS.WriteStream, 'write' | 'isTTY'> = process.stderr
): Promise<boolean> {
  if (!IN_PLACE.has(channel.kind)) return false;
  const dir = firecrawlDir();
  const file = path.join(runningDir(dir), String(process.pid));
  // Rewriting the entry also recreates it if a pruner removed it.
  const touch = () => fs.writeFileSync(file, '');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    touch();
  } catch {
    return false;
  }
  const heartbeat = setInterval(() => {
    try {
      touch();
    } catch {
      // The entry expires, which only lets an install start sooner.
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const remove = () => {
    try {
      fs.unlinkSync(file);
    } catch {
      // A leftover entry expires without a heartbeat.
    }
  };
  process.once('exit', remove);
  unregister = () => {
    clearInterval(heartbeat);
    process.off('exit', remove);
    remove();
  };

  const lock = installLockPath(dir);
  const deadline = Date.now() + PACKAGE_INSTALL_TIMEOUT_MS + 30_000;
  let waited = false;
  while (lockHeld(lock) && Date.now() < deadline) {
    if (!waited && stderr.isTTY) {
      stderr.write('Waiting for a firecrawl update to finish installing...\n');
    }
    waited = true;
    await sleep(200);
  }
  return waited && !lockHeld(lock);
}

/** Runs this command again in a new process, which loads only the installed release. */
export function relaunchAfterUpdate(): number {
  unregisterInvocation();
  const script = process.argv[1];
  if (!script || !fs.existsSync(script)) {
    console.error(
      'firecrawl was updated while this command waited. Run the command again.'
    );
    return 1;
  }
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, script, ...process.argv.slice(2)],
    { stdio: 'inherit' }
  );
  return result.status ?? 1;
}

/**
 * Takes the install lock. For in-place installs it first waits until no other
 * invocation is registered, and checks again after taking the lock so a
 * command that registered meanwhile is not rewritten under. Without onWait,
 * a lock held by another installer ends the attempt instead of waiting.
 */
async function claimInstall(
  dir: string,
  channel: UpdatableChannel,
  onWait?: () => void
): Promise<'claimed' | 'busy' | 'installing'> {
  const lock = installLockPath(dir);
  const idle = () => !IN_PLACE.has(channel.kind) || otherInvocations(dir) === 0;
  const deadline = Date.now() + IDLE_WAIT_MS;
  for (let first = true; ; first = false) {
    if (idle()) {
      if (acquireLock(lock)) {
        if (idle()) return 'claimed';
        releaseLock(lock);
      } else if (!onWait) {
        return 'installing';
      }
    }
    if (first) onWait?.();
    if (Date.now() > deadline) return 'busy';
    await sleep(500);
  }
}

function alreadyInstalled(channel: UpdatableChannel, version: string): boolean {
  if (channel.kind === 'pnpm') {
    return verifyPnpm(channel.packageRoot, version).status === 'installed';
  }
  if (!IN_PLACE.has(channel.kind) || !('packageRoot' in channel)) return false;
  return verifyPackage(channel.packageRoot, version).status === 'installed';
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
  options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {}
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
    const timer = setTimeout(
      () => child.kill(),
      options.timeoutMs ?? INSTALL_TIMEOUT_MS
    );
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

function installedVersion(packageRoot: string): string | undefined {
  const version = readJson(path.join(packageRoot, 'package.json')).version;
  return typeof version === 'string' ? version : undefined;
}

function verifyPackage(packageRoot: string, version: string): Outcome {
  const found = installedVersion(packageRoot);
  return found === version
    ? { status: 'installed' }
    : {
        status: 'failed',
        message: `expected ${version} in ${packageRoot}, found ${found ?? 'nothing'}`,
      };
}

/** pnpm 11+ moves each global install into a new hashed directory beside the old one. */
function verifyPnpm(packageRoot: string, version: string): Outcome {
  const direct = verifyPackage(packageRoot, version);
  if (direct.status === 'installed') return direct;
  const globalDir = path.dirname(path.dirname(path.dirname(packageRoot)));
  try {
    const found = fs
      .readdirSync(globalDir)
      .some(
        (entry) =>
          installedVersion(
            path.join(globalDir, entry, 'node_modules', 'firecrawl-cli')
          ) === version
      );
    return found ? { status: 'installed' } : direct;
  } catch {
    return direct;
  }
}

/** The formula can trail npm; a brew upgrade that lands an older release is not a failure. */
function verifyKeg(cellar: string, version: string): Outcome {
  const newest = fs
    .readdirSync(cellar)
    .map((keg) => keg.replace(/_\d+$/, ''))
    .sort(compareVersions)
    .pop();
  if (!newest) {
    return { status: 'failed', message: `no keg found in ${cellar}` };
  }
  if (compareVersions(newest, version) >= 0) return { status: 'installed' };
  return {
    status: 'pending',
    message: `Homebrew installed ${newest}; npm already has ${version}, and the Homebrew formula has not caught up yet.`,
  };
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`GET ${url} returned ${response.status}`), {
      status: response.status,
    });
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Download, verify, and atomically swap in the release binary. */
async function replaceBinary(
  channel: Extract<InstallChannel, { kind: 'binary' }>,
  version: string,
  log: Log
): Promise<Outcome> {
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
  const failed = (message: string): Outcome => ({ status: 'failed', message });
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
    if (!expected) return failed(`checksums.txt has no entry for ${archive}`);
    const actual = createHash('sha256').update(tarball).digest('hex');
    if (actual !== expected.toLowerCase()) {
      return failed(`checksum mismatch for ${archive}`);
    }
    log('Checksum verified');

    fs.writeFileSync(path.join(tmp, archive), tarball);
    const untarError = await run('tar', ['-xzf', archive], 'ignore', {
      cwd: tmp,
    });
    if (untarError) return failed(untarError);

    const extracted = path.join(tmp, channel.asset);
    const probe = spawnSync(extracted, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: childEnv({ FIRECRAWL_NO_UPDATE_CHECK: '1' }),
    });
    const reported = probe.stdout?.trim();
    if (reported !== version) {
      return failed(
        `downloaded binary reported ${reported || probe.error?.message || 'nothing'}, expected ${version}`
      );
    }

    fs.copyFileSync(extracted, staged);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, channel.executable);
    return { status: 'installed' };
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return {
        status: 'pending',
        message: `The ${version} release binaries are not published yet. Try again later.`,
      };
    }
    return failed(error instanceof Error ? error.message : String(error));
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
): Promise<Outcome> {
  const spec = `firecrawl-cli@${version}`;
  const failed = (message: string): Outcome => ({ status: 'failed', message });
  const timeoutMs = PACKAGE_INSTALL_TIMEOUT_MS;
  let error: string | undefined;
  switch (channel.kind) {
    case 'npm':
      error = await run('npm', ['install', '-g', spec], stdio, {
        env: childEnv({ npm_config_prefix: channel.prefix }),
        timeoutMs,
      });
      return error
        ? failed(error)
        : verifyPackage(channel.packageRoot, version);
    case 'pnpm':
      error = await run('pnpm', ['add', '-g', spec], stdio, { timeoutMs });
      return error ? failed(error) : verifyPnpm(channel.packageRoot, version);
    case 'bun':
      error = await run('bun', ['add', '-g', spec], stdio, { timeoutMs });
      return error
        ? failed(error)
        : verifyPackage(channel.packageRoot, version);
    case 'yarn':
      error = await run('yarn', ['global', 'add', spec], stdio, { timeoutMs });
      return error
        ? failed(error)
        : verifyPackage(channel.packageRoot, version);
    case 'brew':
      error = await run('brew', ['upgrade', 'firecrawl-cli'], stdio);
      return error ? failed(error) : verifyKeg(channel.cellar, version);
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
  updateState(dir, { updated: { ...updated, announced: true } });
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
    const channel = options.channel ?? detectInstallChannel();
    const current = packageJson.version;
    if (autoUpdateBlocker() || !updatesAutomatically(channel)) return false;
    if (isPrerelease(current)) return false;
    if (state.retryAt && Date.parse(state.retryAt) > Date.now()) return false;

    const cached = await readCachedLatest(getCachePath(), new Date());
    if (!cached.stale && cached.latestVersion) {
      if (compareVersions(current, cached.latestVersion) >= 0) return true;
      if (!sameMajor(current, cached.latestVersion)) return false;
    }
    if (lockHeld(workerLockPath(dir))) return true;

    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    const compiled = isCompiledBinary();
    if (!compiled && !process.argv[1]) return false;
    const child = spawn(process.execPath, compiled ? [] : [process.argv[1]], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, [WORKER_ENV]: '1' },
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

/**
 * Body of the detached process startAutoUpdate spawns. Refreshes the version
 * cache, then installs a same-major release once no other command is running.
 */
export async function runAutoUpdateWorker(): Promise<void> {
  const dir = firecrawlDir();
  let logFd: number | undefined;
  try {
    if (!acquireLock(workerLockPath(dir))) return;
    const { fd, log } = openLog(dir);
    logFd = fd;
    const channel = detectInstallChannel();
    const current = packageJson.version;
    if (autoUpdateBlocker() || !updatesAutomatically(channel)) return;
    if (channel.kind === 'unsupported' || isPrerelease(current)) return;

    const latest = await getLatestVersion(packageJson.name, 10_000);
    if (latest.unreachable || !latest.version) {
      log(`Version check failed: ${latest.error ?? 'no version returned'}`);
      updateState(dir, {
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
    const mismatch = engineMismatch(
      channel,
      latest.version,
      latest.nodeRange,
      true
    );
    if (mismatch) {
      log(`Skipping: ${mismatch}`);
      updateState(dir, {
        retryAt: new Date(Date.now() + FAILURE_BACKOFF_MS).toISOString(),
      });
      return;
    }
    const claim = await claimInstall(dir, channel);
    if (claim !== 'claimed') {
      log(
        claim === 'busy'
          ? 'Other firecrawl commands are still running; retrying on a later run'
          : 'Another update is installing'
      );
      return;
    }
    if (autoUpdateBlocker()) return;
    if (alreadyInstalled(channel, latest.version)) {
      log(`${latest.version} is already installed`);
      return;
    }

    log(
      `Updating ${current} -> ${latest.version} with ${CHANNEL_LABELS[channel.kind]}`
    );
    const outcome = await installVersion(
      channel,
      latest.version,
      ['ignore', fd, fd],
      log
    );
    if (outcome.status === 'installed') {
      log(`Updated to ${latest.version}`);
      updateState(dir, {
        retryAt: undefined,
        lastError: undefined,
        updated: {
          from: current,
          to: latest.version,
          at: new Date().toISOString(),
        },
      });
      return;
    }
    log(outcome.message);
    updateState(dir, {
      retryAt: new Date(
        Date.now() +
          (outcome.status === 'pending' ? CHECK_RETRY_MS : FAILURE_BACKOFF_MS)
      ).toISOString(),
      lastError: outcome.status === 'failed' ? outcome.message : undefined,
    });
  } catch (error) {
    updateState(dir, {
      retryAt: new Date(Date.now() + FAILURE_BACKOFF_MS).toISOString(),
      lastError: String(error),
    });
    if (logFd !== undefined) {
      fs.writeSync(logFd, `[${new Date().toISOString()}] ${String(error)}\n`);
    }
  } finally {
    releaseLock(installLockPath(dir));
    releaseLock(workerLockPath(dir));
    if (logFd !== undefined) fs.closeSync(logFd);
  }
}

function manualUpdateHint(code: UnsupportedCode): string {
  switch (code) {
    case 'npx':
      return 'Run npx -y firecrawl-cli@latest to use the latest version.';
    case 'system-package':
      return 'Update it with the system package manager that installed it.';
    case 'windows-binary':
      return 'Rerun the installer from https://docs.firecrawl.dev/cli to update.';
    default:
      return isCompiledBinary()
        ? 'Rerun the installer from https://docs.firecrawl.dev/cli to update.'
        : `Update it the way it was installed, for example: ${updateCommand()}`;
  }
}

/** Foreground update for `firecrawl update`. Resolves false on failure. */
export async function updateNow(): Promise<boolean> {
  const current = packageJson.version;
  const channel = detectInstallChannel();
  if (channel.kind === 'unsupported') {
    console.error(
      `firecrawl ${current} cannot update itself: ${channel.reason}.`
    );
    console.error(manualUpdateHint(channel.code));
    return false;
  }
  if (isPrerelease(current)) {
    console.log(
      `firecrawl ${current} is a prerelease build, so it is not moved to the latest release. Reinstall firecrawl-cli@latest to switch.`
    );
    return true;
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
  const mismatch = engineMismatch(
    channel,
    latest.version,
    latest.nodeRange,
    false
  );
  if (mismatch) {
    console.error(
      `${mismatch}. Upgrade Node, then run firecrawl update again.`
    );
    return false;
  }

  const dir = firecrawlDir();
  const claim = await claimInstall(dir, channel, () =>
    console.error(
      'Waiting for other firecrawl commands and updates to finish...'
    )
  );
  if (claim !== 'claimed') {
    console.error(
      claim === 'busy'
        ? 'Other firecrawl commands are still running. Try again when they finish.'
        : 'Another firecrawl update is installing right now. Try again in a few minutes.'
    );
    return false;
  }
  try {
    if (alreadyInstalled(channel, latest.version)) {
      console.log(`firecrawl ${latest.version} is already installed.`);
      return true;
    }
    console.log(
      `Updating firecrawl ${current} -> ${latest.version} with ${CHANNEL_LABELS[channel.kind]}...`
    );
    const outcome = await installVersion(
      channel,
      latest.version,
      'inherit',
      (message) => console.log(message)
    );
    if (outcome.status === 'failed') {
      console.error(`Update failed: ${outcome.message}`);
      return false;
    }
    if (outcome.status === 'pending') {
      console.log(outcome.message);
      return true;
    }
    updateState(dir, {
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
    releaseLock(installLockPath(dir));
  }
}
