import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  managedRoot,
  readManagedPointer,
  stableVersion,
  installationId,
  hostIdentity,
} from './managed-paths';

const HOST = hostIdentity();
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function stagingPrefix(): string {
  return path.join(managedRoot(), `.install-${HOST}-${process.pid}-`);
}

/** Pin before loading any managed code. Cleanup publishes its intent first. */
export function leaseManagedVersion(version: string): (() => void) | undefined {
  if (!stableVersion(version)) return undefined;
  const root = managedRoot();
  const lease = path.join(
    root,
    version,
    '.leases',
    `${HOST}-${process.pid}-${randomUUID()}`
  );
  const release = () => {
    try {
      fs.rmSync(lease, { force: true });
    } catch {
      /* Best effort at exit. */
    }
  };
  try {
    // Never recreate a version directory that cleanup has already removed.
    fs.writeFileSync(lease, '', { flag: 'wx' });
    if (fs.existsSync(path.join(root, `.deleting-${version}`))) {
      release();
      return undefined;
    }
    return release;
  } catch {
    release();
    return undefined;
  }
}

function hasLiveLeases(versionDir: string): boolean {
  const dir = path.join(versionDir, '.leases');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const name of names) {
    const owner = /^([a-f0-9]{16})-(\d+)-[a-f0-9-]{36}$/.exec(name);
    // Unknown owners and other machines are retained conservatively.
    if (!owner || owner[1] !== HOST || alive(Number(owner[2]))) return true;
    fs.rmSync(path.join(dir, name), { force: true });
  }
  return false;
}

/** Caller holds the updater lock. Maintenance never makes an update fail. */
export function cleanupManagedVersions(
  runningVersion: string,
  log: (message: string) => void = () => {}
): void {
  const root = managedRoot();
  const keep = new Set<string | undefined>([runningVersion]);
  const pointers = path.join(root, 'pointers');
  try {
    for (const identity of fs.readdirSync(pointers)) {
      if (!/^[a-f0-9]{64}$/.test(identity)) continue;
      const pointer = readManagedPointer(identity);
      if (!pointer) continue;
      let obsolete = false;
      if (pointer.host === HOST) {
        try {
          obsolete = installationId(pointer.packageRoot) !== identity;
        } catch (error) {
          obsolete = (error as NodeJS.ErrnoException).code === 'ENOENT';
        }
      }
      if (obsolete) {
        fs.rmSync(path.join(pointers, identity), {
          recursive: true,
          force: true,
        });
        continue;
      }
      keep.add(pointer.version);
      keep.add(pointer.previous);
    }
  } catch (error) {
    // Without a complete snapshot, no release can safely be removed.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(
        `Could not scan managed pointers: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, entry.name);
    try {
      const staging = /^\.install-([a-f0-9]{16})-(\d+)-/.exec(entry.name);
      if (staging) {
        if (
          staging[1] === HOST &&
          !alive(Number(staging[2])) &&
          Date.now() - fs.statSync(target).mtimeMs > STAGING_MAX_AGE_MS
        ) {
          fs.rmSync(target, { recursive: true, force: true });
        }
        continue;
      }
      if (!stableVersion(entry.name) || keep.has(entry.name)) continue;
      const marker = path.join(root, `.deleting-${entry.name}`);
      if (fs.existsSync(marker)) {
        const owner = /^([a-f0-9]{16})-(\d+)$/.exec(
          fs.readFileSync(marker, 'utf8')
        );
        if (owner && (owner[1] !== HOST || alive(Number(owner[2])))) continue;
        // A fresh empty marker may still be receiving its owner's pid.
        if (
          !owner &&
          Date.now() - fs.statSync(marker).mtimeMs < STAGING_MAX_AGE_MS
        )
          continue;
        fs.rmSync(marker);
      }
      fs.writeFileSync(marker, `${HOST}-${process.pid}`, { flag: 'wx' });
      try {
        // Readers that entered before the marker are visible here. Later
        // readers see the marker and use the global package instead.
        if (!hasLiveLeases(target))
          fs.rmSync(target, { recursive: true, force: true });
      } finally {
        fs.rmSync(marker, { force: true });
      }
    } catch (error) {
      log(
        `Could not clean ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
