import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { updatesAutomatically } from '../../utils/auto-update';
import {
  classifyInstall,
  detectInstallChannel,
} from '../../utils/install-channel';

const linux = {
  platform: 'linux' as const,
  arch: 'x64',
  execPath: '/usr/bin/node',
};
const fromModule = (moduleDir: string, overrides = {}) =>
  classifyInstall({ ...linux, moduleDir, ...overrides });

describe('classifyInstall', () => {
  it('detects npm global installs and their prefix', () => {
    expect(
      fromModule('/usr/local/lib/node_modules/firecrawl-cli/dist/utils')
    ).toEqual({
      kind: 'npm',
      packageRoot: '/usr/local/lib/node_modules/firecrawl-cli',
      prefix: '/usr/local',
    });
    expect(
      fromModule(
        '/home/u/.nvm/versions/node/v24.1.0/lib/node_modules/firecrawl-cli/dist/utils'
      )
    ).toMatchObject({
      kind: 'npm',
      prefix: '/home/u/.nvm/versions/node/v24.1.0',
    });
    expect(
      fromModule(
        'C:\\Users\\A User\\AppData\\Roaming\\npm\\node_modules\\firecrawl-cli\\dist\\utils',
        { platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe' }
      )
    ).toEqual({
      kind: 'npm',
      packageRoot:
        'C:\\Users\\A User\\AppData\\Roaming\\npm\\node_modules\\firecrawl-cli',
      prefix: 'C:\\Users\\A User\\AppData\\Roaming\\npm',
    });
  });

  it('detects pnpm, bun, and yarn global installs', () => {
    expect(
      fromModule(
        '/home/u/.local/share/pnpm/global/v11/7da1d-18e4-0/node_modules/.pnpm/firecrawl-cli@1.26.24_debug@4.4.3/node_modules/firecrawl-cli/dist/utils'
      )
    ).toEqual({
      kind: 'pnpm',
      packageRoot:
        '/home/u/.local/share/pnpm/global/v11/7da1d-18e4-0/node_modules/firecrawl-cli',
    });
    expect(
      fromModule(
        '/home/u/.local/share/pnpm/global/5/node_modules/.pnpm/firecrawl-cli@1.26.24/node_modules/firecrawl-cli/dist/utils'
      )
    ).toEqual({
      kind: 'pnpm',
      packageRoot:
        '/home/u/.local/share/pnpm/global/5/node_modules/firecrawl-cli',
    });
    expect(
      fromModule(
        '/home/u/.bun/install/global/node_modules/firecrawl-cli/dist/utils'
      )
    ).toMatchObject({ kind: 'bun' });
    expect(
      fromModule(
        '/home/u/.config/yarn/global/node_modules/firecrawl-cli/dist/utils'
      )
    ).toMatchObject({ kind: 'yarn' });
    expect(
      fromModule(
        'C:\\Users\\u\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\firecrawl-cli\\dist\\utils',
        { platform: 'win32' }
      )
    ).toMatchObject({ kind: 'yarn' });
  });

  it('skips package runners and local installs', () => {
    expect(
      fromModule('/home/u/.npm/_npx/6a9f/node_modules/firecrawl-cli/dist/utils')
    ).toEqual({
      kind: 'unsupported',
      code: 'npx',
      reason: 'running through npx',
    });
    expect(
      fromModule(
        '/home/u/.cache/pnpm/dlx/abc/def/node_modules/.pnpm/firecrawl-cli@1.0.0/node_modules/firecrawl-cli/dist/utils'
      )
    ).toEqual({
      kind: 'unsupported',
      code: 'package-runner',
      reason: 'running through a package runner',
    });
    expect(
      fromModule('/home/u/project/node_modules/firecrawl-cli/dist/utils')
    ).toEqual({
      kind: 'unsupported',
      code: 'not-global',
      reason: 'not installed as a global package',
    });
    expect(fromModule('/home/u/src/cli/dist/utils')).toMatchObject({
      kind: 'unsupported',
    });
  });

  it('detects Homebrew installs from the module or executable path', () => {
    const brew = fromModule(
      '/home/linuxbrew/.linuxbrew/Cellar/firecrawl-cli/1.26.9/libexec/lib/node_modules/firecrawl-cli/dist/utils'
    );
    expect(brew).toEqual({
      kind: 'brew',
      cellar: '/home/linuxbrew/.linuxbrew/Cellar/firecrawl-cli',
    });
    expect(updatesAutomatically(brew)).toBe(false);
    expect(
      fromModule(
        '/opt/homebrew/Cellar/firecrawl-cli/1.26.9/libexec/lib/node_modules/firecrawl-cli/dist/utils',
        { platform: 'darwin' }
      )
    ).toEqual({ kind: 'brew', cellar: '/opt/homebrew/Cellar/firecrawl-cli' });
    expect(
      fromModule('/$bunfs/root', {
        platform: 'darwin',
        execPath: '/opt/homebrew/Cellar/firecrawl-cli/1.26.9/bin/firecrawl',
      })
    ).toEqual({ kind: 'brew', cellar: '/opt/homebrew/Cellar/firecrawl-cli' });
  });

  it('maps standalone binaries to their release asset', () => {
    expect(
      fromModule('/$bunfs/root', { execPath: '/home/u/.local/bin/firecrawl' })
    ).toEqual({
      kind: 'binary',
      executable: '/home/u/.local/bin/firecrawl',
      asset: 'firecrawl-linux-x64',
    });
    expect(
      fromModule('/$bunfs/root', {
        platform: 'darwin',
        arch: 'arm64',
        execPath: '/Users/u/.local/bin/firecrawl',
      })
    ).toMatchObject({ kind: 'binary', asset: 'firecrawl-darwin-arm64' });
  });

  it('skips binaries owned by a system package manager or on Windows', () => {
    expect(
      fromModule('/$bunfs/root', { execPath: '/usr/bin/firecrawl' })
    ).toEqual({
      kind: 'unsupported',
      code: 'system-package',
      reason: 'installed by a system package manager',
    });
    expect(
      fromModule('B:\\~BUN\\root', {
        platform: 'win32',
        execPath: 'C:\\Users\\u\\AppData\\Local\\firecrawl\\bin\\firecrawl.exe',
      })
    ).toMatchObject({ kind: 'unsupported', code: 'windows-binary' });
  });
});

describe.skipIf(process.platform === 'win32')('detectInstallChannel', () => {
  it('updates a standalone binary only for the user who owns it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-owner-'));
    const executable = path.join(dir, 'firecrawl');
    fs.writeFileSync(executable, '', { mode: 0o755 });
    const paths = { ...linux, moduleDir: '/$bunfs/root', execPath: executable };
    try {
      expect(detectInstallChannel(paths)).toMatchObject({
        kind: 'binary',
        executable,
      });

      const uid = vi
        .spyOn(process, 'getuid')
        .mockReturnValue(fs.statSync(executable).uid + 1);
      try {
        expect(detectInstallChannel(paths)).toEqual({
          kind: 'unsupported',
          code: 'not-writable',
          reason: 'the binary belongs to another user',
        });
      } finally {
        uid.mockRestore();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
