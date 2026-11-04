import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import packageJson from '../../package.json';
import { cleanupManagedVersions } from './managed-lifecycle';
import {
  installManagedVersion,
  managedRegistry,
  rollbackManagedVersion,
} from './managed-update';
import { selectedManagedVersion } from './managed-paths';
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
const LOG_FILE = 'auto-update.log';
const WORKER_ENV = 'FIRECRAWL_AUTO_UPDATE_WORKER';
const RELEASES_URL = 'https://github.com/firecrawl/cli/releases/download';
const CHECK_RETRY_MS = 60 * 60 * 1000;
const OBSERVATION_DELAY_MS = 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
// A lock file exists for a moment before its pid is written.
const LOCK_WRITE_GRACE_MS = 10 * 1000;
const BOOT_TOLERANCE_MS = 5 * 60 * 1000;
const LOG_MAX_BYTES = 256 * 1024;

interface AutoUpdateState {
  candidate?: { version: string; observedAt: string };
  previous?: { executable: string; version: string; sha256: string };
  retryAt?: string;
  lastError?: string;
  updated?: { from: string; to: string; at: string; announced?: boolean };
}

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

function updateState(dir: string, patch: AutoUpdateState): boolean {
  return writeJson(path.join(dir, STATE_FILE), { ...readState(dir), ...patch });
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

/** Eligible installs use atomic binary replacement or a versioned package store. */
export function updatesAutomatically(
  channel: InstallChannel
): channel is Extract<
  InstallChannel,
  { kind: 'binary' | 'npm' | 'pnpm' | 'bun' | 'yarn' | 'managed' }
> {
  return ['binary', 'npm', 'pnpm', 'bun', 'yarn', 'managed'].includes(
    channel.kind
  );
}

async function installUpdate(
  channel: InstallChannel,
  version: string,
  log: Log
): Promise<Outcome> {
  if (channel.kind === 'binary') return replaceBinary(channel, version, log);
  try {
    log(`Installing ${version} in the managed version store`);
    await installManagedVersion(version, packageJson.version);
    return { status: 'installed' };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function sameMajor(a: string, b: string): boolean {
  const major = (v: string) => parseInt(v.replace(/^v/, ''), 10);
  return major(a) === major(b);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function workerLockPath(dir: string): string {
  return path.join(dir, LOCK_FILE);
}

function bootTime(): number {
  return Date.now() - os.uptime() * 1000;
}

/** A live updater holds its lock while its heartbeat is fresh. */
function lockHeld(file: string): boolean {
  let age: number;
  try {
    age = Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return false;
  }
  const { pid, bootedAt } = readJson(file);
  if (typeof pid !== 'number') return age < LOCK_WRITE_GRACE_MS;
  if (
    typeof bootedAt === 'number' &&
    Math.abs(bootedAt - bootTime()) > BOOT_TOLERANCE_MS
  ) {
    return false;
  }
  return (
    pid > 0 && Number.isInteger(pid) && isAlive(pid) && age < HEARTBEAT_STALE_MS
  );
}

/**
 * Replaces a stale lock under a short-lived guard. The lock file never
 * disappears during a takeover, so a process creating it fresh cannot slip in
 * between the staleness check and the replacement.
 */
function takeOverStaleLock(file: string, content: string): boolean {
  const guard = `${file}.takeover`;
  try {
    fs.writeFileSync(guard, '', { flag: 'wx' });
  } catch {
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > LOCK_WRITE_GRACE_MS) {
        fs.rmSync(guard, { force: true });
      }
    } catch {
      // Another process just released the guard.
    }
    return false;
  }
  try {
    if (!fs.existsSync(file) || lockHeld(file)) return false;
    const staged = `${file}.${process.pid}`;
    fs.writeFileSync(staged, content);
    fs.renameSync(staged, file);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(guard, { force: true });
  }
}

const lockHeartbeats = new Map<string, NodeJS.Timeout>();

/** 'failed' means the lock file could not be written at all, not that someone holds it. */
function acquireLock(file: string): 'acquired' | 'held' | 'failed' {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return 'failed';
  }
  const content = JSON.stringify({
    pid: process.pid,
    bootedAt: bootTime(),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, content, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'failed';
      if (lockHeld(file)) return 'held';
      if (!takeOverStaleLock(file, content)) continue;
    }
    const heartbeat = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(file, now, now);
      } catch {
        // The lock goes stale, which only lets another updater start sooner.
      }
    }, HEARTBEAT_MS);
    heartbeat.unref();
    lockHeartbeats.set(file, heartbeat);
    return 'acquired';
  }
  return 'held';
}

function releaseLock(file: string): void {
  clearInterval(lockHeartbeats.get(file));
  lockHeartbeats.delete(file);
  try {
    if (readJson(file).pid === process.pid) fs.rmSync(file, { force: true });
  } catch {
    // A stale lock expires on its own.
  }
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

/** Probe in a separate process with all automatic checks disabled. */
function binaryVersion(executable: string): string | undefined {
  const probe = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env: childEnv({ FIRECRAWL_NO_UPDATE_CHECK: '1' }),
  });
  const version = probe.stdout?.trim();
  return !probe.error &&
    probe.status === 0 &&
    /^\d+\.\d+\.\d+$/.test(version ?? '')
    ? version
    : undefined;
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
  const failed = (message: string): Outcome => ({ status: 'failed', message });
  // Staged beside the executable: the system temp directory may be mounted
  // noexec, and the rename into place must stay on one filesystem.
  let tmp: string;
  try {
    tmp = fs.mkdtempSync(
      path.join(path.dirname(channel.executable), '.firecrawl-update-')
    );
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  try {
    const original = fs.statSync(channel.executable);
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
    const untar = spawnSync('tar', ['-xzf', archive, channel.asset], {
      cwd: tmp,
      stdio: 'ignore',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    if (untar.error || untar.status !== 0)
      return failed('Could not extract the release binary.');

    const extracted = path.join(tmp, channel.asset);
    if (!fs.lstatSync(extracted).isFile())
      return failed('The release binary is not a regular file.');
    const reported = binaryVersion(extracted);
    if (reported !== version) {
      return failed(
        `downloaded binary reported ${reported || 'nothing'}, expected ${version}`
      );
    }

    fs.chmodSync(extracted, 0o755);
    const current = fs.statSync(channel.executable);
    if (
      current.ino !== original.ino ||
      current.dev !== original.dev ||
      current.mtimeMs !== original.mtimeMs
    ) {
      return {
        status: 'pending',
        message:
          'The executable changed during the update. Run firecrawl again.',
      };
    }
    const previousVersion = binaryVersion(channel.executable);
    if (!previousVersion)
      return failed(
        'Could not verify the installed binary before backing it up.'
      );
    const previous = path.join(tmp, 'previous');
    fs.copyFileSync(channel.executable, previous);
    const sha256 = createHash('sha256')
      .update(fs.readFileSync(previous))
      .digest('hex');
    fs.renameSync(previous, `${channel.executable}.previous`);
    if (
      !updateState(firecrawlDir(), {
        previous: {
          executable: channel.executable,
          version: previousVersion,
          sha256,
        },
      })
    ) {
      return failed(
        'Could not record the previous version; leaving the installed binary unchanged.'
      );
    }
    fs.renameSync(extracted, channel.executable);
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
    fs.rmSync(tmp, { recursive: true, force: true });
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
    if (updateCheckDisabled()) return false;
    const dir = firecrawlDir();
    const state = readState(dir);
    const channel = options.channel ?? detectInstallChannel();
    if (updatesAutomatically(channel)) {
      announceUpdate(dir, state, options.stderr ?? process.stderr);
    }
    const current = packageJson.version;
    if (autoUpdateBlocker() || !updatesAutomatically(channel)) return false;
    if (isPrerelease(current)) return false;
    if (state.retryAt && Date.parse(state.retryAt) > Date.now()) return false;

    const cached = await readCachedLatest(getCachePath(), new Date());
    if (cached.latestVersion) {
      if (!cached.stale && isPrerelease(cached.latestVersion)) return false;
      // The worker never crosses a major version, so that release belongs to
      // the notice even before a stale cache is refreshed.
      if (
        compareVersions(current, cached.latestVersion) < 0 &&
        !sameMajor(current, cached.latestVersion)
      ) {
        return false;
      }
      if (
        !cached.stale &&
        compareVersions(current, cached.latestVersion) >= 0
      ) {
        return true;
      }
    }
    if (lockHeld(workerLockPath(dir))) return true;

    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    const compiled = isCompiledBinary();
    // The launcher pins the selected package before the worker loads its code.
    const entry = process.env.FIRECRAWL_LAUNCHER_PATH || process.argv[1];
    if (!compiled && !entry) return false;
    const child = spawn(process.execPath, compiled ? [] : [entry], {
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
 * cache, then atomically installs a same-major stable release.
 */
export async function runAutoUpdateWorker(): Promise<void> {
  const dir = firecrawlDir();
  let logFd: number | undefined;
  try {
    if (acquireLock(workerLockPath(dir)) !== 'acquired') return;
    const { fd, log } = openLog(dir);
    logFd = fd;
    const saveState = (patch: AutoUpdateState) => {
      if (!updateState(dir, patch))
        throw new Error(
          'Could not save update state. Check permissions on ~/.firecrawl/auto-update-state.json.'
        );
    };
    const channel = detectInstallChannel();
    const current = packageJson.version;
    if (autoUpdateBlocker() || !updatesAutomatically(channel)) return;
    if (isPrerelease(current)) return;
    if (channel.kind !== 'binary') cleanupManagedVersions(current, log);

    const latest = await getLatestVersion(
      packageJson.name,
      10_000,
      channel.kind === 'binary' ? undefined : managedRegistry()
    );
    if (latest.unreachable || !latest.version) {
      log(`Version check failed: ${latest.error ?? 'no version returned'}`);
      saveState({
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
      lastShownHint: cached.lastShownHint,
    });

    const remembered = readState(dir).candidate;
    if (remembered && remembered.version !== latest.version) {
      saveState({ candidate: undefined });
    }
    if (
      isPrerelease(latest.version) ||
      compareVersions(current, latest.version) >= 0
    )
      return;
    if (!sameMajor(current, latest.version)) {
      log(`${latest.version} is a new major version; leaving it to the notice`);
      return;
    }
    const state = readState(dir);
    const observedAt =
      state.candidate?.version === latest.version
        ? Date.parse(state.candidate.observedAt)
        : NaN;
    if (!Number.isFinite(observedAt) || observedAt > Date.now()) {
      saveState({
        candidate: {
          version: latest.version,
          observedAt: new Date().toISOString(),
        },
        retryAt: new Date(Date.now() + OBSERVATION_DELAY_MS).toISOString(),
      });
      log(
        `Observed ${latest.version}; waiting 24 hours before automatic installation.`
      );
      return;
    }
    if (Date.now() - observedAt < OBSERVATION_DELAY_MS) {
      saveState({
        retryAt: new Date(observedAt + OBSERVATION_DELAY_MS).toISOString(),
      });
      return;
    }
    if (autoUpdateBlocker()) return;
    log(`Updating ${current} -> ${latest.version}`);
    const outcome = await installUpdate(channel, latest.version, log);
    if (outcome.status === 'installed') {
      log(`Updated to ${latest.version}`);
      saveState({
        retryAt: undefined,
        lastError: undefined,
        candidate: undefined,
        updated: {
          from: current,
          to: latest.version,
          at: new Date().toISOString(),
        },
      });
      return;
    }
    log(outcome.message);
    saveState({
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
    releaseLock(workerLockPath(dir));
    if (logFd !== undefined) fs.closeSync(logFd);
  }
}

/** How to update this install by hand. */
export function updateHint(channel: InstallChannel): string {
  if (channel.kind === 'unsupported') return manualUpdateHint(channel.code);
  const commands = {
    npm: 'firecrawl update',
    managed: 'firecrawl update',
    pnpm: 'pnpm add -g firecrawl-cli@latest',
    bun: 'bun add -g firecrawl-cli@latest',
    yarn: 'yarn global add firecrawl-cli@latest',
    brew: 'brew upgrade firecrawl-cli',
    binary: 'firecrawl update',
  };
  const original = process.env.FIRECRAWL_INSTALL_CHANNEL;
  const kind =
    channel.kind === 'managed' &&
    ['pnpm', 'bun', 'yarn'].includes(original ?? '')
      ? (original as 'pnpm' | 'bun' | 'yarn')
      : channel.kind;
  return `Run ${commands[kind]} to update.`;
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
  const channel = detectInstallChannel();
  if (!updatesAutomatically(channel)) {
    console.error(
      `This installation is updated externally. ${updateHint(channel)}`
    );
    return false;
  }
  // The launcher runs update from the installed package, not the release it selects.
  const current =
    (!isPrerelease(packageJson.version) &&
      channel.kind !== 'binary' &&
      selectedManagedVersion(packageJson.version)) ||
    packageJson.version;
  if (isPrerelease(current)) {
    console.log(
      `firecrawl ${current} is a prerelease build, so it is not moved to the latest release. Rerun the installer to switch to a stable release.`
    );
    return true;
  }

  let latest: Awaited<ReturnType<typeof getLatestVersion>>;
  try {
    latest = await getLatestVersion(
      packageJson.name,
      10_000,
      channel.kind === 'binary' ? undefined : managedRegistry()
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (channel.kind !== 'binary' && channel.kind !== 'npm')
      console.error(updateHint(channel));
    return false;
  }
  if (latest.unreachable || !latest.version) {
    console.error(
      `Could not check for updates: ${latest.error ?? 'no version returned'}`
    );
    return false;
  }
  if (isPrerelease(latest.version)) {
    console.error(
      'The latest release is a prerelease; leaving this installation unchanged.'
    );
    return false;
  }
  const upToDate = compareVersions(current, latest.version) >= 0;
  const dir = firecrawlDir();
  const lock = workerLockPath(dir);
  const claim = acquireLock(lock);
  if (claim !== 'acquired') {
    if (upToDate) {
      console.log(`firecrawl ${current} is up to date.`);
      return true;
    }
    console.error(
      claim === 'held'
        ? 'Another firecrawl update is running. Try again when it finishes.'
        : `Could not create ${lock}. Check that ${dir} is writable.`
    );
    return false;
  }
  try {
    if (channel.kind !== 'binary') cleanupManagedVersions(current);
    if (upToDate) {
      console.log(`firecrawl ${current} is up to date.`);
      return true;
    }
    console.log(`Updating firecrawl ${current} -> ${latest.version}...`);
    const outcome = await installUpdate(channel, latest.version, (message) =>
      console.log(message)
    );
    if (outcome.status === 'failed') {
      console.error(`Update failed: ${outcome.message}`);
      return false;
    }
    if (outcome.status === 'pending') {
      console.error(outcome.message);
      return false;
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
    releaseLock(lock);
  }
}

/** Restore the previous installation without needing the network. */
export async function rollbackUpdate(): Promise<boolean> {
  const channel = detectInstallChannel();
  if (!updatesAutomatically(channel)) {
    console.error(
      `Rollback is not supported for this installation. ${updateHint(channel)}`
    );
    return false;
  }
  const dir = firecrawlDir();
  const lock = workerLockPath(dir);
  if (acquireLock(lock) !== 'acquired') {
    console.error(
      'Could not acquire the update lock. Check permissions or wait for the running update.'
    );
    return false;
  }
  let tmp: string | undefined;
  let restoreSettings: (() => boolean) | undefined;
  const disableForRollback = () => {
    const file = path.join(dir, SETTINGS_FILE);
    const existed = fs.existsSync(file);
    const original = readJson(file);
    if (!setAutoUpdateEnabled(false))
      throw new Error('Could not disable automatic updates before rollback.');
    restoreSettings = () => {
      if (existed) return writeJson(file, original);
      fs.rmSync(file, { force: true });
      return true;
    };
  };
  try {
    if (channel.kind !== 'binary') {
      const restored = rollbackManagedVersion(
        packageJson.version,
        disableForRollback
      );
      restoreSettings = undefined;
      updateState(dir, {
        updated: undefined,
        candidate: undefined,
        retryAt: undefined,
        lastError: undefined,
      });
      console.log(`Restored firecrawl ${restored}. Automatic updates are off.`);
      return true;
    }
    const previous = readState(dir).previous;
    const backup = `${channel.executable}.previous`;
    let backupIsFile = false;
    try {
      backupIsFile = fs.lstatSync(backup).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (
      !previous ||
      previous.executable !== channel.executable ||
      !backupIsFile
    ) {
      console.error('No previous version is available for this installation.');
      return false;
    }
    tmp = fs.mkdtempSync(
      path.join(path.dirname(channel.executable), '.firecrawl-update-')
    );
    const staged = path.join(tmp, 'firecrawl');
    fs.copyFileSync(backup, staged);
    const sha256 = createHash('sha256')
      .update(fs.readFileSync(staged))
      .digest('hex');
    if (
      sha256 !== previous.sha256 ||
      binaryVersion(staged) !== previous.version
    ) {
      console.error(
        'The previous binary failed verification; leaving the installed version unchanged.'
      );
      return false;
    }
    fs.chmodSync(staged, 0o755);
    disableForRollback();
    fs.renameSync(staged, channel.executable);
    restoreSettings = undefined;
    updateState(dir, {
      updated: undefined,
      candidate: undefined,
      retryAt: undefined,
      lastError: undefined,
    });
    console.log(
      `Restored firecrawl ${previous.version}. Automatic updates are off; use firecrawl update --enable-auto to re-enable them.`
    );
    return true;
  } catch (error) {
    try {
      if (restoreSettings && !restoreSettings())
        console.error('Could not restore the automatic-update preference.');
    } catch {
      console.error('Could not restore the automatic-update preference.');
    }
    console.error(
      `Rollback failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    releaseLock(lock);
  }
}
