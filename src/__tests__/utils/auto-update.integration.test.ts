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
  let uptime: { mockRestore: () => void };

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

  function entry(pid: number, ageMs = 0, marker = ''): string {
    fs.mkdirSync(runningDir(), { recursive: true });
    const file = path.join(runningDir(), String(pid));
    fs.writeFileSync(file, marker);
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
    // Stale entries are backdated past what a freshly booted CI runner has been up.
    const booted = os.uptime() + 24 * 3600;
    uptime = vi.spyOn(os, 'uptime').mockReturnValue(booted);
  });

  afterEach(() => {
    uptime.mockRestore();
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

  it.skipIf(process.platform === 'win32')(
    'keeps counting a stopped command that missed its heartbeats',
    async () => {
      const command = spawn(
        process.execPath,
        [
          '-e',
          "process.stdout.write('ready'); setTimeout(() => {}, 60000)",
          'firecrawl',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] }
      );
      children.push(command);
      await new Promise((resolve) => command.stdout!.once('data', resolve));
      command.kill('SIGSTOP');
      const stopped = entry(command.pid!, 11 * 60 * 1000);

      expect(otherInvocations(firecrawlDir())).toBe(1);
      expect(fs.existsSync(stopped)).toBe(true);
    }
  );

  /** A stopped process running script, the way the CLI runs dist/index.js. */
  async function stoppedScript(script: string): Promise<ChildProcess> {
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(
      script,
      "process.stdout.write('ready'); setTimeout(() => {}, 60000);"
    );
    const child = spawn(process.execPath, [script], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.push(child);
    await new Promise((resolve) => child.stdout!.once('data', resolve));
    child.kill('SIGSTOP');
    return child;
  }

  it.skipIf(process.platform === 'win32')(
    'prunes a stale entry whose pid now runs another firecrawl program',
    async () => {
      const cli = path.join(
        home,
        'lib/node_modules/firecrawl-cli/dist/index.js'
      );
      // The reused pid runs something else that only mentions firecrawl.
      const other = await stoppedScript(
        path.join(home, 'firecrawl-mcp/dist/index.js')
      );
      const reused = entry(other.pid!, 11 * 60 * 1000, cli);
      const command = await stoppedScript(cli);
      const stopped = entry(command.pid!, 11 * 60 * 1000, cli);

      expect(otherInvocations(firecrawlDir())).toBe(1);
      expect(fs.existsSync(stopped)).toBe(true);
      expect(fs.existsSync(reused)).toBe(false);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'keeps the install lock of a stopped installer, not of a reused pid',
    async () => {
      const cli = path.join(
        home,
        'lib/node_modules/firecrawl-cli/dist/index.js'
      );
      const lockOf = async (holder: ChildProcess) => {
        fs.mkdirSync(firecrawlDir(), { recursive: true });
        fs.writeFileSync(
          installLock(),
          JSON.stringify({
            pid: holder.pid,
            bootedAt: Date.now() - os.uptime() * 1000,
            command: cli,
          })
        );
        const at = new Date(Date.now() - 11 * 60 * 1000);
        fs.utimesSync(installLock(), at, at);
      };

      await lockOf(await stoppedScript(cli));
      await expect(
        registerInvocation(npmChannel, terminal(), 300)
      ).resolves.toBe('busy');

      await lockOf(await stoppedScript(path.join(home, 'firecrawl-mcp/x.js')));
      await expect(registerInvocation(npmChannel, terminal())).resolves.toBe(
        'run'
      );
    }
  );

  it('registers a command without waiting when nothing is installing', async () => {
    await expect(registerInvocation(npmChannel, terminal())).resolves.toBe(
      'run'
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
      'relaunch'
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('Waiting for a firecrawl update')
    );
  });

  it('relaunches only when another release was installed meanwhile', async () => {
    const packageRoot = path.join(home, 'firecrawl-cli');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ version: packageJson.version })
    );
    fs.mkdirSync(firecrawlDir(), { recursive: true });
    fs.writeFileSync(installLock(), JSON.stringify({ pid: liveProcess().pid }));
    setTimeout(() => fs.rmSync(installLock(), { force: true }), 300);

    await expect(
      registerInvocation({ ...npmChannel, packageRoot }, terminal())
    ).resolves.toBe('run');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('waits on a lock that is still being written, but not on an abandoned one', async () => {
    fs.mkdirSync(firecrawlDir(), { recursive: true });
    fs.writeFileSync(installLock(), '');
    setTimeout(() => fs.rmSync(installLock(), { force: true }), 300);
    await expect(registerInvocation(npmChannel, terminal())).resolves.toBe(
      'relaunch'
    );

    fs.writeFileSync(installLock(), '');
    const at = new Date(Date.now() - 2 * 60 * 1000);
    fs.utimesSync(installLock(), at, at);
    const started = Date.now();
    await expect(registerInvocation(npmChannel, terminal())).resolves.toBe(
      'run'
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('ignores an install lock taken before the machine last booted', async () => {
    fs.mkdirSync(firecrawlDir(), { recursive: true });
    fs.writeFileSync(
      installLock(),
      JSON.stringify({
        pid: liveProcess().pid,
        bootedAt: Date.now() - os.uptime() * 1000 - 24 * 3_600_000,
      })
    );

    await expect(registerInvocation(npmChannel, terminal())).resolves.toBe(
      'run'
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('ignores an install lock left by a process that is gone', async () => {
    fs.mkdirSync(firecrawlDir(), { recursive: true });
    fs.writeFileSync(installLock(), JSON.stringify({ pid: await deadPid() }));

    await expect(registerInvocation(npmChannel, terminal())).resolves.toBe(
      'run'
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('gives up on an install that outlasts the wait, without running or touching its lock', async () => {
    fs.mkdirSync(firecrawlDir(), { recursive: true });
    fs.writeFileSync(installLock(), JSON.stringify({ pid: liveProcess().pid }));

    await expect(registerInvocation(npmChannel, terminal(), 500)).resolves.toBe(
      'busy'
    );
    expect(write).toHaveBeenLastCalledWith(
      expect.stringContaining('still installing. Run the command again')
    );
    expect(fs.existsSync(path.join(runningDir(), String(process.pid)))).toBe(
      false
    );
    expect(fs.existsSync(installLock())).toBe(true);
  });

  it('leaves binary installs alone, since they swap the file atomically', async () => {
    const binary: InstallChannel = {
      kind: 'binary',
      executable: path.join(home, 'firecrawl'),
      asset: 'firecrawl-linux-x64',
    };
    fs.mkdirSync(firecrawlDir(), { recursive: true });
    fs.writeFileSync(installLock(), JSON.stringify({ pid: liveProcess().pid }));

    await expect(registerInvocation(binary, terminal())).resolves.toBe('run');
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

  const binary = (): InstallChannel => ({
    kind: 'binary',
    executable: path.join(home, 'firecrawl'),
    asset: 'firecrawl-linux-x64',
  });

  it('never starts an update for a package manager install', async () => {
    cache('1.0.0', 48);
    await expect(
      startAutoUpdate({ channel: npmChannel, stderr: quiet })
    ).resolves.toBe(false);
    expect(
      fs.existsSync(path.join(home, '.firecrawl', 'auto-update.lock'))
    ).toBe(false);
  });

  it('leaves a new major version to the notice, even from a stale cache', async () => {
    cache('99.0.0', 1);
    await expect(
      startAutoUpdate({ channel: binary(), stderr: quiet })
    ).resolves.toBe(false);

    cache('99.0.0', 48);
    await expect(
      startAutoUpdate({ channel: binary(), stderr: quiet })
    ).resolves.toBe(false);
    expect(
      fs.existsSync(path.join(home, '.firecrawl', 'auto-update.lock'))
    ).toBe(false);
  });

  it('keeps the notice quiet when the cache shows this release is current', async () => {
    cache(packageJson.version, 1);
    await expect(
      startAutoUpdate({ channel: binary(), stderr: quiet })
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

  /**
   * A stand-in package manager that starts a helper and records its pid.
   * 'stubborn' ignores SIGINT and SIGTERM, as some installers do. 'rollback'
   * restores the previous install after either signal only once a release
   * file appears, as npm does once its downloads finish.
   */
  function installer(mode: 'exit' | 'stubborn' | 'rollback'): string[] {
    const script = path.join(dir, 'installer.js');
    fs.writeFileSync(
      script,
      `const { spawn } = require('child_process');
const fs = require('fs');
const [, , pidFile, mode] = process.argv;
if (mode === 'stubborn') for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => {});
if (mode === 'rollback') for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => setInterval(() => { if (!fs.existsSync(pidFile + '.release')) return; fs.writeFileSync(pidFile + '.restored', ''); process.exit(1); }, 50));
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(pidFile + '.tmp', String(helper.pid));
fs.renameSync(pidFile + '.tmp', pidFile);
if (mode === 'exit') process.exit(0);
setInterval(() => {}, 1000);
`
    );
    return [script, path.join(dir, 'helper.pid'), mode];
  }

  const helperPid = () =>
    Number(fs.readFileSync(path.join(dir, 'helper.pid'), 'utf8'));

  /** Resolves once the stand-in installer is up, so no assertion races its startup. */
  async function started(): Promise<number> {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(path.join(dir, 'helper.pid'))) {
      if (Date.now() > deadline) {
        throw new Error('the stand-in installer did not start');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return helperPid();
  }

  /** Starts run() and returns the SIGINT listener it registered. */
  function runWithInterrupt(args: string[]) {
    const before = new Set(process.listeners('SIGINT'));
    const pending = run(process.execPath, args, 'ignore');
    const interrupt = process
      .listeners('SIGINT')
      .find((listener) => !before.has(listener)) as (signal: string) => void;
    return { pending, interrupt };
  }

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

  it('kills everything a command with a time limit started once the limit runs out', async () => {
    const pending = run(process.execPath, installer('stubborn'), 'ignore', {
      timeoutMs: 1000,
    });
    const helper = await started();

    expect(await pending).toContain('timed out');
    expect(alive(helper)).toBe(false);
  }, 15_000);

  it('waits for helpers an installer leaves behind before it resolves', async () => {
    const pending = run(process.execPath, installer('exit'), 'ignore');
    const helper = await started();

    expect(await pending).toBeUndefined();
    expect(alive(helper)).toBe(false);
  }, 15_000);

  const restored = () => fs.existsSync(path.join(dir, 'helper.pid.restored'));

  /** Runs fn with setTimeout faked, then lets an hour of it pass. */
  function anHourLater(fn: () => void) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      fn();
      vi.advanceTimersByTime(60 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  }

  it('lets an interrupted installer restore the previous install, however long that takes', async () => {
    let runner: ReturnType<typeof runWithInterrupt> | undefined;
    anHourLater(() => {
      runner = runWithInterrupt(installer('rollback'));
    });
    const { pending, interrupt } = runner!;
    let settled = false;
    void pending.then(() => (settled = true));
    await started();

    anHourLater(() => interrupt('SIGINT'));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(settled).toBe(false);
    expect(restored()).toBe(false);

    fs.writeFileSync(path.join(dir, 'helper.pid.release'), '');
    expect(await pending).toContain('interrupted by SIGINT');
    expect(restored()).toBe(true);
  }, 20_000);

  it('kills the installer at once on a second interrupt', async () => {
    const { pending, interrupt } = runWithInterrupt(installer('stubborn'));
    const helper = await started();

    const begun = Date.now();
    interrupt('SIGINT');
    interrupt('SIGINT');
    expect(await pending).toContain('interrupted by SIGINT');
    expect(Date.now() - begun).toBeLessThan(2_000);
    expect(alive(helper)).toBe(false);
  });
});
