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
const IDLE_WAIT_MS = 30 * 60 * 1000;
const CHECK_RETRY_MS = 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
// Package installs have no time limit, so a command stops waiting on one
// after this and asks to be run again.
const INSTALL_WAIT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const HEARTBEAT_STALE_MS = 10 * 60 * 1000;
// A lock file exists for a moment before its pid is written.
const LOCK_WRITE_GRACE_MS = 10 * 1000;
const BOOT_TOLERANCE_MS = 5 * 60 * 1000;
const LOG_MAX_BYTES = 256 * 1024;
const IN_PLACE = new Set(['npm', 'pnpm', 'bun', 'yarn']);

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

/**
 * Only the standalone binary updates in the background, since it swaps in with
 * one atomic rename. A package manager removes and rewrites the launcher and
 * the files a starting command loads, and an unattended brew upgrade can update
 * brew and other formulae, so those installs get the notice instead.
 */
export function updatesAutomatically(
  channel: InstallChannel
): channel is Extract<InstallChannel, { kind: 'binary' }> {
  return channel.kind === 'binary';
}

function sameMajor(a: string, b: string): boolean {
  const major = (v: string) => parseInt(v.replace(/^v/, ''), 10);
  return major(a) === major(b);
}

/** A range this cannot read lets the install go ahead; the package manager reports any engine problem. */
function engineMismatch(
  channel: UpdatableChannel,
  version: string,
  nodeRange: string | undefined
): string | undefined {
  if (!IN_PLACE.has(channel.kind) || !nodeRange) return undefined;
  if (satisfiesRange(process.versions.node, nodeRange) !== false) {
    return undefined;
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
 * How this process appears in a process listing: the script node runs, or the
 * binary itself. Entries and locks record it so a reused pid can be told apart.
 */
function commandMarker(): string {
  return (isCompiledBinary() ? process.execPath : process.argv[1]) ?? '';
}

const PROBE_TTL_MS = 30 * 1000;
const probes = new Map<string, { at: number; verdict: boolean }>();

/**
 * Whether pid may still run the command that recorded marker. A stopped or
 * suspended command misses heartbeats but still runs it, while a reused pid
 * runs something else. An entry without a marker falls back to the word
 * firecrawl. Verdicts are cached briefly, since waiting loops ask every 500ms.
 */
function mayRunFirecrawl(pid: number, marker = ''): boolean {
  const needle = (marker || 'firecrawl').toLowerCase();
  const key = `${pid}\0${needle}`;
  const cached = probes.get(key);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.verdict;
  const verdict = probeCommandLine(pid, needle);
  probes.set(key, { at: Date.now(), verdict });
  return verdict;
}

/**
 * Only a command line that was read and names something else rules the
 * command out: a failed or timed out lookup cannot tell, and neither can an
 * empty one outside Linux, since Windows hides the command line of processes
 * it will not show. On Linux an empty /proc command line belongs to a kernel
 * thread or a zombie.
 */
function probeCommandLine(pid: number, needle: string): boolean {
  try {
    if (process.platform === 'linux') {
      return fs
        .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        .toLowerCase()
        .includes(needle);
    }
    const [command, args] =
      process.platform === 'win32'
        ? [
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
            ],
          ]
        : ['ps', ['-p', String(pid), '-o', 'args=']];
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return true;
    return (
      !result.stdout.trim() || result.stdout.toLowerCase().includes(needle)
    );
  } catch {
    return true;
  }
}

/**
 * Counts other live invocations and prunes the rest. A killed process leaves
 * its entry behind and its pid can later belong to an unrelated process, so
 * an entry without a recent heartbeat counts only while its pid may still run
 * firecrawl, and never once it predates the last boot.
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
    let mtime: number;
    let marker: string;
    try {
      mtime = fs.statSync(file).mtimeMs;
      marker = fs.readFileSync(file, 'utf8').trim();
    } catch {
      continue;
    }
    const live =
      Number.isInteger(pid) &&
      pid > 0 &&
      mtime > bootTime() - BOOT_TOLERANCE_MS &&
      isAlive(pid) &&
      (Date.now() - mtime < HEARTBEAT_STALE_MS || mayRunFirecrawl(pid, marker));
    if (live) count++;
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

function bootTime(): number {
  return Date.now() - os.uptime() * 1000;
}

/**
 * A lock is held while the process that took it is alive and keeps it fresh.
 * A pid recorded before the last boot, or in a lock nobody refreshes, may now
 * belong to an unrelated process. A holder that was stopped misses heartbeats
 * but still holds the lock while its pid runs the command that took it.
 */
function lockHeld(file: string): boolean {
  let age: number;
  try {
    age = Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return false;
  }
  const { pid, bootedAt, command } = readJson(file);
  if (typeof pid !== 'number') return age < LOCK_WRITE_GRACE_MS;
  if (
    typeof bootedAt === 'number' &&
    Math.abs(bootedAt - bootTime()) > BOOT_TOLERANCE_MS
  ) {
    return false;
  }
  if (!isAlive(pid)) return false;
  if (age < HEARTBEAT_STALE_MS) return true;
  return typeof command === 'string' && command !== ''
    ? mayRunFirecrawl(pid, command)
    : false;
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
    command: commandMarker(),
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

let unregister: (() => void) | undefined;

/** Drops this process's running entry, before it exits or relaunches. */
export function unregisterInvocation(): void {
  unregister?.();
  unregister = undefined;
}

/**
 * Package installs are rewritten in place and commands load modules lazily.
 * Each invocation registers itself so an install waits for it, and waits
 * for an install that is already running before it continues. Resolves
 * 'relaunch' when another release was installed while it waited: this process
 * already loaded the old one, so the caller should relaunch on the new one.
 * Resolves 'busy' when the install is still running after waitMs: the command
 * must not run against a package that is still being rewritten.
 */
export async function registerInvocation(
  channel: InstallChannel,
  stderr: Pick<NodeJS.WriteStream, 'write' | 'isTTY'> = process.stderr,
  waitMs = INSTALL_WAIT_MS
): Promise<'run' | 'relaunch' | 'busy'> {
  if (!IN_PLACE.has(channel.kind) || !('packageRoot' in channel)) return 'run';
  const dir = firecrawlDir();
  const file = path.join(runningDir(dir), String(process.pid));
  // Rewriting the entry also recreates it if a pruner removed it.
  const marker = commandMarker();
  const touch = () => fs.writeFileSync(file, marker);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    touch();
  } catch {
    return 'run';
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
  const deadline = Date.now() + waitMs;
  let waited = false;
  while (lockHeld(lock)) {
    if (Date.now() >= deadline) {
      unregisterInvocation();
      stderr.write(
        'A firecrawl update is still installing. Run the command again once it finishes.\n'
      );
      return 'busy';
    }
    if (!waited && stderr.isTTY) {
      stderr.write('Waiting for a firecrawl update to finish installing...\n');
    }
    waited = true;
    await sleep(200);
  }
  return waited && installedVersion(channel.packageRoot) !== packageJson.version
    ? 'relaunch'
    : 'run';
}

/**
 * Runs this command again in a new process, which loads only the installed
 * release, and resolves to its exit code, or 128 plus the signal number when a
 * signal stopped it. The child shares the terminal's process group, so it
 * already receives Ctrl-C and hangups; this process only outlives them, and
 * passes on SIGTERM, which is sent to one pid.
 */
export function relaunchAfterUpdate(): Promise<number> {
  unregisterInvocation();
  const script = process.argv[1];
  if (!script || !fs.existsSync(script)) {
    console.error(
      'firecrawl was updated while this command waited. Run the command again.'
    );
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, script, ...process.argv.slice(2)],
      { stdio: 'inherit' }
    );
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    const ignore = () => {};
    process.on('SIGTERM', forward);
    process.on('SIGINT', ignore);
    process.on('SIGHUP', ignore);
    const finish = (code: number) => {
      process.off('SIGTERM', forward);
      process.off('SIGINT', ignore);
      process.off('SIGHUP', ignore);
      resolve(code);
    };
    child.on('error', () => finish(1));
    child.on('exit', (code, signal) =>
      finish(code ?? 128 + (signal ? os.constants.signals[signal] : 0))
    );
  });
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
): Promise<'claimed' | 'busy' | 'installing' | 'failed'> {
  const lock = installLockPath(dir);
  const idle = () => !IN_PLACE.has(channel.kind) || otherInvocations(dir) === 0;
  const deadline = Date.now() + IDLE_WAIT_MS;
  for (let first = true; ; first = false) {
    if (idle()) {
      const result = acquireLock(lock);
      if (result === 'acquired') {
        if (idle()) return 'claimed';
        releaseLock(lock);
      } else if (result === 'failed') {
        return 'failed';
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

function npmEnv(channel: UpdatableChannel): NodeJS.ProcessEnv {
  return childEnv(
    channel.kind === 'npm' ? { npm_config_prefix: channel.prefix } : {}
  );
}

/**
 * npm and pnpm also read the registry from npmrc files, which the version
 * check cannot see, so ask the one that will install. Only the URL is read.
 */
function configuredRegistry(channel: UpdatableChannel): string | undefined {
  if (channel.kind !== 'npm' && channel.kind !== 'pnpm') return undefined;
  const windows = process.platform === 'win32';
  const result = spawnSync(
    windows ? `${channel.kind}.cmd` : channel.kind,
    ['config', 'get', 'registry'],
    {
      cwd: os.tmpdir(),
      env: npmEnv(channel),
      encoding: 'utf8',
      shell: windows,
      timeout: 10_000,
      windowsHide: true,
    }
  );
  const registry = result.stdout?.trim();
  return registry && /^https?:\/\//.test(registry) ? registry : undefined;
}

/**
 * Signals a child and everything it started: its process group, or its tree on
 * Windows, where only SIGKILL forces the tree to close.
 */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') {
      const force = signal === 'SIGKILL' ? ['/F'] : [];
      spawnSync('taskkill', ['/pid', String(pid), '/T', ...force], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // Nothing left to signal.
  }
}

/** Waits for the child's process group to empty, escalating to SIGKILL. */
async function reapGroup(pid: number): Promise<boolean> {
  for (const signal of [undefined, 'SIGTERM', 'SIGKILL'] as const) {
    if (signal) signalTree(pid, signal);
    const deadline = Date.now() + KILL_GRACE_MS;
    while (isAlive(-pid) && Date.now() < deadline) await sleep(100);
    if (!isAlive(-pid)) return true;
  }
  return false;
}

/**
 * Resolves to an error message, or undefined when the command succeeded.
 * Package managers start helpers of their own, so the child gets its own
 * process group: an interrupt or a timeout reaches all of it, and this waits
 * for that group to empty. Helpers still running after the command exits are
 * stopped, and a group that survives SIGKILL is reported as a failure; the
 * caller still releases its lock. Windows skips the group wait.
 *
 * An interrupt is only passed on, so a package manager can restore what it
 * replaced however long that takes. A second interrupt kills it at once. Only
 * a caller that sets timeoutMs gets a time limit: SIGTERM, then SIGKILL after
 * KILL_GRACE_MS.
 */
export function run(
  command: string,
  args: string[],
  stdio: StdioOptions,
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs?: number;
  } = {}
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const windows = process.platform === 'win32';
    const shell = windows && ['npm', 'pnpm', 'yarn'].includes(command);
    const child = spawn(shell ? `${command}.cmd` : command, args, {
      stdio,
      env: options.env ?? childEnv(),
      cwd: options.cwd,
      shell,
      windowsHide: true,
      detached: !windows,
    });
    const { timeoutMs } = options;
    let stopped: string | undefined;
    let escalate: NodeJS.Timeout | undefined;
    const kill = () => child.pid && signalTree(child.pid, 'SIGKILL');
    const stop = (reason: string, signal: NodeJS.Signals) => {
      if (stopped !== undefined) {
        kill();
        return;
      }
      stopped = reason;
      clearTimeout(timer);
      if (child.pid) signalTree(child.pid, signal);
      if (signal === 'SIGINT' && stdio === 'inherit') {
        console.error(
          `Stopping ${command} so it can restore the previous version. Press Ctrl+C again to stop it now, which can leave firecrawl uninstalled.`
        );
      }
    };
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            stop(`timed out after ${Math.round(timeoutMs / 1000)}s`, 'SIGTERM');
            escalate = setTimeout(kill, KILL_GRACE_MS);
          }, timeoutMs);
    // The child no longer shares the terminal's process group, so pass
    // interrupts and hangups on.
    const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const interrupt = (signal: NodeJS.Signals) =>
      stop(`interrupted by ${signal}`, signal);
    for (const signal of forwarded) process.on(signal, interrupt);

    let settled = false;
    const finish = (error: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalate);
      for (const signal of forwarded) process.off(signal, interrupt);
      resolve(error);
    };
    child.on('error', (error) => finish(`${command}: ${error.message}`));
    child.on('exit', async (code, signal) => {
      const reaped = windows || !child.pid || (await reapGroup(child.pid));
      const failure =
        stopped ?? (code === 0 ? undefined : `exited with ${code ?? signal}`);
      if (!failure && reaped) return finish(undefined);
      finish(
        `${command} ${args.join(' ')} ${failure ?? 'succeeded'}${reaped ? '' : ', and processes it started are still running'}`
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
      timeoutMs: INSTALL_TIMEOUT_MS,
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

    fs.chmodSync(extracted, 0o755);
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

async function installVersion(
  channel: UpdatableChannel,
  version: string,
  log: Log
): Promise<Outcome> {
  const spec = `firecrawl-cli@${version}`;
  const failed = (message: string): Outcome => ({ status: 'failed', message });
  // A global install must not pick up the project files (package.json,
  // .npmrc, bunfig.toml) of whatever directory the command ran in.
  const options = { cwd: os.tmpdir() };
  let error: string | undefined;
  switch (channel.kind) {
    case 'npm':
      error = await run('npm', ['install', '-g', spec], 'inherit', {
        ...options,
        env: npmEnv(channel),
      });
      return error
        ? failed(error)
        : verifyPackage(channel.packageRoot, version);
    case 'pnpm':
      error = await run('pnpm', ['add', '-g', spec], 'inherit', options);
      return error ? failed(error) : verifyPnpm(channel.packageRoot, version);
    case 'bun':
      error = await run('bun', ['add', '-g', spec], 'inherit', options);
      return error
        ? failed(error)
        : verifyPackage(channel.packageRoot, version);
    case 'yarn':
      error = await run('yarn', ['global', 'add', spec], 'inherit', options);
      return error
        ? failed(error)
        : verifyPackage(channel.packageRoot, version);
    case 'brew':
      error = await run('brew', ['upgrade', 'firecrawl-cli'], 'inherit');
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
    if (cached.latestVersion) {
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
    if (acquireLock(workerLockPath(dir)) !== 'acquired') return;
    const { fd, log } = openLog(dir);
    logFd = fd;
    const channel = detectInstallChannel();
    const current = packageJson.version;
    if (autoUpdateBlocker() || !updatesAutomatically(channel)) return;
    if (isPrerelease(current)) return;

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
    const claim = await claimInstall(dir, channel);
    if (claim !== 'claimed') {
      log(
        {
          busy: 'Other firecrawl commands are still running; retrying on a later run',
          installing: 'Another update is installing',
          failed: `Could not create ${installLockPath(dir)}; retrying on a later run`,
        }[claim]
      );
      return;
    }
    if (autoUpdateBlocker()) return;

    log(
      `Updating ${current} -> ${latest.version} with ${CHANNEL_LABELS[channel.kind]}`
    );
    const outcome = await replaceBinary(channel, latest.version, log);
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

/** How to update this install by hand. */
export function updateHint(channel: InstallChannel): string {
  if (channel.kind === 'unsupported') return manualUpdateHint(channel.code);
  if (channel.kind === 'brew') {
    return 'Run brew upgrade firecrawl-cli to update.';
  }
  return 'Run firecrawl update to update.';
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

  const latest = await getLatestVersion(
    packageJson.name,
    10_000,
    configuredRegistry(channel)
  );
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
  const mismatch = engineMismatch(channel, latest.version, latest.nodeRange);
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
      {
        busy: 'Other firecrawl commands are still running. Try again when they finish.',
        installing:
          'Another firecrawl update is installing right now. Try again in a few minutes.',
        failed: `Could not create ${installLockPath(dir)}. Check that ${dir} is writable.`,
      }[claim]
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
    // The installer keeps the terminal for prompts (registry login, one-time
    // passwords): a process in its own session may still read it.
    const outcome = await installVersion(channel, latest.version, (message) =>
      console.log(message)
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
