import fs from 'fs';
import os from 'os';
import path from 'path';

export interface ManagedPointer {
  version: string;
  previous?: string;
}

export const stableVersion = (version: unknown): version is string =>
  typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version);

// Separate Node runtimes so an update installed with one runtime is never
// selected by a launcher running an older, incompatible Node version.
export function managedRoot(): string {
  let home = os.homedir();
  try {
    home = fs.realpathSync(home);
  } catch {
    /* The installer creates a missing home. */
  }
  return path.join(
    home,
    '.firecrawl',
    'versions',
    `node-${process.versions.node}`
  );
}

export function managedPackage(version: string): string {
  return path.join(managedRoot(), version, 'node_modules', 'firecrawl-cli');
}

export function readManagedPointer(): ManagedPointer | undefined {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(managedRoot(), 'current.json'), 'utf8')
    );
    if (!stableVersion(value?.version)) return undefined;
    if (value.previous !== undefined && !stableVersion(value.previous))
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** Resolve only an intact, matching package inside the managed store. */
export function managedEntry(version: string): string | undefined {
  if (!stableVersion(version)) return undefined;
  try {
    const root = managedPackage(version);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    );
    const entry = path.join(root, 'dist', 'index.js');
    if (manifest.name !== 'firecrawl-cli' || manifest.version !== version)
      return undefined;
    if (
      fs.realpathSync(entry) !==
        path.join(
          fs.realpathSync(managedRoot()),
          version,
          'node_modules',
          'firecrawl-cli',
          'dist',
          'index.js'
        ) ||
      !fs.statSync(entry).isFile()
    )
      return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

export function writeManagedPointer(pointer: ManagedPointer): void {
  const root = managedRoot();
  fs.mkdirSync(root, { recursive: true });
  const staged = path.join(root, `current.${process.pid}.tmp`);
  try {
    fs.writeFileSync(staged, JSON.stringify(pointer) + '\n');
    fs.renameSync(staged, path.join(root, 'current.json'));
  } finally {
    fs.rmSync(staged, { force: true });
  }
}
