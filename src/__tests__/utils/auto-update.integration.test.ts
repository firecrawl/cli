import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  otherInvocations,
  registerInvocation,
  unregisterInvocation,
} from '../../utils/auto-update';
import type { InstallChannel } from '../../utils/install-channel';

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
