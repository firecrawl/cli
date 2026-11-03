import fs from 'fs';
import path from 'path';
import { managedRoot, stableVersion } from './managed-paths';

export type PackageManagerChannel = 'npm' | 'pnpm' | 'bun' | 'yarn' | 'managed';

export type InstallChannel =
  | { kind: PackageManagerChannel; packageRoot: string; prefix?: string }
  | { kind: 'brew'; cellar: string }
  | { kind: 'binary'; executable: string; asset: string }
  | { kind: 'unsupported'; code: UnsupportedCode; reason: string };

export type UnsupportedCode =
  | 'npx'
  | 'package-runner'
  | 'not-global'
  | 'system-package'
  | 'not-writable'
  | 'windows-binary'
  | 'unsupported-platform';

export interface InstallPaths {
  /** dist/utils for package installs, the virtual entry path for compiled binaries. */
  moduleDir: string;
  execPath: string;
  platform: NodeJS.Platform;
  arch: string;
}

const COMPILED_ENTRY = /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/;
const CELLAR = /^(.*[\\/]Cellar[\\/]firecrawl-cli)[\\/]/;
const SYSTEM_BIN = /^\/(?:usr\/)?s?bin\//;

/** Compiled binaries run from a virtual entry path; __dirname may still name the build machine. */
export function isCompiledBinary(): boolean {
  return [process.argv[1], __dirname].some(
    (entry) => !!entry && COMPILED_ENTRY.test(entry)
  );
}

export function isHomebrewPath(p: string): boolean {
  return CELLAR.test(p);
}

function unsupported(code: UnsupportedCode, reason: string): InstallChannel {
  return { kind: 'unsupported', code, reason };
}

/** Classify how the running CLI was installed, from its paths alone. */
export function classifyInstall({
  moduleDir,
  execPath,
  platform,
  arch,
}: InstallPaths): InstallChannel {
  const cellar = [moduleDir, execPath]
    .map((p) => CELLAR.exec(p)?.[1])
    .find(Boolean);
  if (cellar) return { kind: 'brew', cellar };

  if (COMPILED_ENTRY.test(moduleDir)) {
    if (platform === 'win32') {
      return unsupported(
        'windows-binary',
        'Windows standalone binaries are updated by rerunning the installer'
      );
    }
    if (SYSTEM_BIN.test(execPath)) {
      return unsupported(
        'system-package',
        'installed by a system package manager'
      );
    }
    const os = platform === 'darwin' || platform === 'linux' ? platform : null;
    const cpu = arch === 'x64' || arch === 'arm64' ? arch : null;
    if (!os || !cpu) {
      return unsupported(
        'unsupported-platform',
        `no release binary for ${platform}-${arch}`
      );
    }
    return {
      kind: 'binary',
      executable: execPath,
      asset: `firecrawl-${os}-${cpu}`,
    };
  }

  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = p.resolve(moduleDir, '..', '..');
  const slashed = root.replaceAll('\\', '/');

  const relative = p.relative(managedRoot(), root).split(p.sep);
  if (
    relative.length === 3 &&
    stableVersion(relative[0]) &&
    relative.slice(1).join('/') === 'node_modules/firecrawl-cli'
  ) {
    return { kind: 'managed', packageRoot: root };
  }

  if (slashed.includes('/_npx/')) {
    return unsupported('npx', 'running through npx');
  }
  if (/\/(?:dlx|bunx-[^/]*|xfs-[^/]*)\//.test(slashed)) {
    return unsupported('package-runner', 'running through a package runner');
  }
  if (!slashed.endsWith('/node_modules/firecrawl-cli')) {
    return unsupported('not-global', 'not installed as a global package');
  }

  if (/\/pnpm\/global\//i.test(slashed)) {
    const store = slashed.indexOf('/node_modules/.pnpm/');
    const packageRoot =
      store === -1
        ? root
        : p.join(root.slice(0, store), 'node_modules', 'firecrawl-cli');
    return { kind: 'pnpm', packageRoot };
  }
  if (slashed.includes('/.bun/install/global/node_modules/')) {
    return { kind: 'bun', packageRoot: root };
  }
  if (/\/yarn\/(?:data\/)?global\/node_modules\//i.test(slashed)) {
    return { kind: 'yarn', packageRoot: root };
  }

  const nodeModules = p.dirname(root);
  if (platform === 'win32') {
    return { kind: 'npm', packageRoot: root, prefix: p.dirname(nodeModules) };
  }
  if (p.basename(p.dirname(nodeModules)) === 'lib') {
    return {
      kind: 'npm',
      packageRoot: root,
      prefix: p.dirname(p.dirname(nodeModules)),
    };
  }
  return unsupported('not-global', 'not installed as a global package');
}

function writable(...paths: string[]): boolean {
  try {
    for (const target of paths) fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Root can write anywhere, so a replacement staged as root would hand another
 * user's binary to root and stop that user's own updates.
 */
function ownedByUser(file: string): boolean {
  if (!process.getuid) return true;
  try {
    return fs.statSync(file).uid === process.getuid();
  } catch {
    return false;
  }
}

/** Classify the running install; only self-updating binaries need a write check. */
export function detectInstallChannel(
  paths: InstallPaths = {
    moduleDir: isCompiledBinary() ? '/$bunfs/root' : __dirname,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
  }
): InstallChannel {
  let moduleDir = paths.moduleDir;
  try {
    if (!COMPILED_ENTRY.test(moduleDir)) {
      moduleDir = fs.realpathSync(moduleDir);
    }
  } catch {
    // Keep the reported path.
  }
  const channel = classifyInstall({ ...paths, moduleDir });
  if (channel.kind === 'npm') {
    // A project dependency can have the same layout, especially on Windows.
    // Only a global install has its launcher directly in the prefix's bin path.
    const shim =
      paths.platform === 'win32'
        ? path.join(channel.prefix!, 'firecrawl.cmd')
        : path.join(channel.prefix!, 'bin', 'firecrawl');
    if (!fs.existsSync(shim))
      return unsupported('not-global', 'not installed as a global package');
  }
  const notWritable = unsupported(
    'not-writable',
    'the install location is not writable by this user'
  );

  if (channel.kind !== 'binary') return channel;
  if (!writable(path.dirname(channel.executable), channel.executable)) {
    return notWritable;
  }
  return ownedByUser(channel.executable)
    ? channel
    : unsupported('not-writable', 'the binary belongs to another user');
}
