import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  managedEntry,
  managedRoot,
  readManagedPointer,
  stableVersion,
  writeManagedPointer,
} from './managed-paths';
import { compareVersions } from './npm-registry';

function installerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FIRECRAWL_AUTO_UPDATE_WORKER;
  return env;
}

/** Read npm's user configuration only in the updater, never at CLI startup. */
export function managedRegistry(): string | undefined {
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['config', 'get', 'registry'],
    {
      cwd: os.tmpdir(),
      env: installerEnv(),
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 10_000,
      windowsHide: true,
    }
  );
  const registry = result.stdout?.trim();
  return !result.error &&
    result.status === 0 &&
    registry &&
    /^https?:\/\//.test(registry)
    ? registry
    : undefined;
}

function verify(entry: string, version: string): boolean {
  const probe = spawnSync(process.execPath, [entry, '--version'], {
    env: { ...installerEnv(), FIRECRAWL_NO_UPDATE_CHECK: '1' },
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
  return !probe.error && probe.status === 0 && probe.stdout.trim() === version;
}

/** npm writes only a private staging directory. Existing releases stay intact. */
export async function installManagedVersion(
  version: string,
  currentVersion: string
): Promise<void> {
  if (!stableVersion(version))
    throw new Error('Invalid stable release version.');
  const root = managedRoot();
  fs.mkdirSync(root, { recursive: true });
  const previous = readManagedPointer();
  if (previous && compareVersions(previous.version, version) > 0) {
    throw new Error(
      'A newer managed release is already active. Run firecrawl again.'
    );
  }
  const target = path.join(root, version);
  let entry = managedEntry(version);
  if (!entry) {
    // An existing, damaged version might still be in use. Never remove it.
    if (fs.existsSync(target))
      throw new Error(
        `The saved ${version} installation is incomplete. Reinstall it manually after stopping commands that use it.`
      );
    const staging = fs.mkdtempSync(path.join(root, '.install-'));
    try {
      fs.writeFileSync(
        path.join(staging, 'package.json'),
        JSON.stringify({ private: true })
      );
      await new Promise<void>((resolve, reject) => {
        const windows = process.platform === 'win32';
        const child = spawn(
          windows ? 'npm.cmd' : 'npm',
          [
            'install',
            '--global=false',
            '--prefix',
            '.',
            '--ignore-scripts',
            '--no-package-lock',
            '--no-audit',
            '--no-fund',
            '--engine-strict',
            `firecrawl-cli@${version}`,
          ],
          {
            cwd: staging,
            env: installerEnv(),
            stdio: 'ignore',
            shell: windows,
            windowsHide: true,
            timeout: 10 * 60 * 1000,
            killSignal: 'SIGKILL',
          }
        );
        child.once('error', reject);
        child.once('close', (code, signal) =>
          code === 0
            ? resolve()
            : reject(
                new Error(
                  `npm install failed (${signal ?? code}). The current installation is unchanged.`
                )
              )
        );
      });
      const stagedEntry = path.join(
        staging,
        'node_modules',
        'firecrawl-cli',
        'dist',
        'index.js'
      );
      if (!verify(stagedEntry, version))
        throw new Error('The downloaded package failed its version check.');
      fs.renameSync(staging, target);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    entry = managedEntry(version);
  }
  if (!entry || !verify(entry, version))
    throw new Error('The saved package failed its version check.');
  writeManagedPointer({
    version,
    previous:
      previous?.version === version
        ? previous.previous
        : previous?.version === currentVersion
          ? previous.version
          : undefined,
  });
}

/** Caller holds the update lock; disable automatic updates just before switching. */
export function rollbackManagedVersion(
  currentVersion: string,
  beforeSwitch: () => void
): string {
  const pointer = readManagedPointer();
  if (!pointer || pointer.version !== currentVersion)
    throw new Error('No managed update is active for this installation.');
  if (pointer.previous) {
    const entry = managedEntry(pointer.previous);
    if (!entry || !verify(entry, pointer.previous))
      throw new Error('The previous package failed its version check.');
    beforeSwitch();
    writeManagedPointer({ version: pointer.previous });
    return pointer.previous;
  }
  beforeSwitch();
  fs.rmSync(path.join(managedRoot(), 'current.json'));
  return 'the package-manager installation';
}
