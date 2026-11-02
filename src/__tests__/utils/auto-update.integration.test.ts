import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  otherInvocations,
  registerInvocation,
  run,
  startAutoUpdate,
  unregisterInvocation,
} from '../../utils/auto-update';
import type { InstallChannel } from '../../utils/install-channel';
import packageJson from '../../../package.json';

const npmChannel: InstallChannel = {
  kind: 'npm',
  packageRoot: '/unused/lib/node_modules/firecrawl-cli',
  prefix: '/unused',
};

describe('install coordination', () => {
  let home: string;
  let saved: { HOME?: string; USERPROFILE?: string };
  let children: ChildProcess[];
  let write: ReturnType<typeof vi.fn>;

  const firecrawlDir = () => path.join(home, '.firecrawl');
  const runningDir = () => path.join(firecrawlDir(), 'running');
  const installLock = () =>
    path.join(firecrawlDir(), 'auto-update-install.lock');
  const terminal = () => ({
    isTTY: true,
    write: write as unknown as NodeJS.WriteStream['write'],
  });

  function liveProcess(): ChildProcess {
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)'],
      {
        stdio: 'ignore',
      }
    );
    children.push(child);
    return child;
  }

  async function deadPid(): Promise<number> {
    const child = liveProcess();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGKILL');
    });
    return child.pid!;
  }

  function entry(pid: number, ageMs = 0): string {
    fs.mkdirSync(runningDir(), { recursive: true });
    const file = path.join(runningDir(), String(pid));
    fs.writeFileSync(file, '');
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(file, at, at);
    return file;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-coordination-'));
    saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    children = [];
    write = vi.fn();
  });

  afterEach(() => {
    unregisterInvocation();
    for (const child of children) child.kill('SIGKILL');
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('counts live commands and prunes entries from killed commands', async () => {
    const live = entry(liveProcess().pid!);
    const killed = entry(await deadPid());
    // A killed command's pid now belongs to an unrelated live process: no heartbeat.
    const reused = entry(liveProcess().pid!, 11 * 60 * 1000);

    expect(otherInvocations(firecrawlDir())).toBe(1);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(killed)).toBe(false);
    expect(fs.existsSync(reused)).toBe(false);
  });

  it('registers a command without waiting when nothing is installing', async () => {
    await expect(registerInvocation(npmChannel, terminal())).resolves.toBe(
      false
    );
    expect(fs.existsSync(path.join(runningDir(), String(process.pid)))).toBe(
      true
    );
    expect(write).not.toHaveBeenCalled();

    unregisterInvocation();
    expect(fs.existsSync(path.join(runningDir(), String(process.pid)))).toBe(
      false
    );
  });

  it('waits for a running install, says so, and asks for a relaunch', async () => {
    fs.mkdirSync(firecrawlDir(), { recursive: true });
    fs.writeFileSync(installLock(), JSON.stringify({ pid: liveProcess().pid }));
    setTimeout(() => fs.rmSync(installLock(), { force: true }), 600);

    const started = Date.now();
    await expect(registerInvocation(npmChannel, terminal())).resolves.toBe(
      true
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('Waiting for a firecrawl update')
    );
  });

  it('ignores an install lock left by a process that is gone', async () => {
    fs.mkdirSync(firecrawlDir(), { recursive: true });
    fs.writeFileSync(installLock(), JSON.stringify({ pid: await deadPid() }));

    await expect(registerInvocation(npmChannel, terminal())).resolves.toBe(
      false
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('leaves binary installs alone, since they swap the file atomically', async () => {
    const binary: InstallChannel = {
      kind: 'binary',
      executable: path.join(home, 'firecrawl'),
      asset: 'firecrawl-linux-x64',
    };
    fs.mkdirSync(firecrawlDir(), { recursive: true });
    fs.writeFileSync(installLock(), JSON.stringify({ pid: liveProcess().pid }));

    await expect(registerInvocation(binary, terminal())).resolves.toBe(false);
    expect(fs.existsSync(runningDir())).toBe(false);
  });
});

describe('startAutoUpdate', () => {
  const names = [
    'HOME',
    'USERPROFILE',
    'CI',
    'FIRECRAWL_NO_AUTO_UPDATE',
    'FIRECRAWL_NO_UPDATE_CHECK',
  ];
  let home: string;
  let saved: Record<string, string | undefined>;
  const quiet = { isTTY: false, write: () => true };

  function cache(latestVersion: string, hoursAgo: number): void {
    const dir = path.join(home, '.firecrawl');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'update-check.json'),
      JSON.stringify({
        latestVersion,
        checkedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
      })
    );
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-start-'));
    saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('leaves a new major version to the notice, even from a stale cache', async () => {
    cache('99.0.0', 1);
    await expect(
      startAutoUpdate({ channel: npmChannel, stderr: quiet })
    ).resolves.toBe(false);

    cache('99.0.0', 48);
    await expect(
      startAutoUpdate({ channel: npmChannel, stderr: quiet })
    ).resolves.toBe(false);
    expect(
      fs.existsSync(path.join(home, '.firecrawl', 'auto-update.lock'))
    ).toBe(false);
  });

  it('keeps the notice quiet when the cache shows this release is current', async () => {
    cache(packageJson.version, 1);
    await expect(
      startAutoUpdate({ channel: npmChannel, stderr: quiet })
    ).resolves.toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('installer processes', () => {
  let dir: string;

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** A stand-in package manager that starts a helper and records its pid. */
  function installer(mode: 'hang' | 'exit'): string[] {
    const script = path.join(dir, 'installer.js');
    fs.writeFileSync(
      script,
      `const { spawn } = require('child_process');
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('fs').writeFileSync(process.argv[2], String(helper.pid));
if (process.argv[3] === 'exit') process.exit(0);
setInterval(() => {}, 1000);
`
    );
    return [script, path.join(dir, 'helper.pid'), mode];
  }

  const helperPid = () =>
    Number(fs.readFileSync(path.join(dir, 'helper.pid'), 'utf8'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-installer-'));
  });

  afterEach(() => {
    try {
      process.kill(helperPid(), 'SIGKILL');
    } catch {
      // Already stopped, which is what the tests expect.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stops everything the installer started when it times out', async () => {
    const error = await run(process.execPath, installer('hang'), 'ignore', {
      timeoutMs: 500,
    });

    expect(error).toContain('timed out');
    expect(alive(helperPid())).toBe(false);
  });

  it('waits for helpers an installer leaves behind before it resolves', async () => {
    const error = await run(process.execPath, installer('exit'), 'ignore');

    expect(error).toBeUndefined();
    expect(alive(helperPid())).toBe(false);
  }, 15_000);
});
