import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import packageJson from '../../../package.json';

// Compiles and runs real binaries against a local registry and release server.
// Run explicitly with pnpm test:update; ordinary tests need neither Bun nor tar.
describe.skipIf(
  process.env.npm_lifecycle_event !== 'test:update' ||
    process.platform === 'win32'
)('standalone update end to end', () => {
  const current = packageJson.version;
  const [major, minor, patch] = current.split('.').map(Number);
  const next = `${major}.${minor}.${patch + 1}`;
  const nextMajor = `${major + 1}.0.0`;
  const asset = `firecrawl-${process.platform}-${process.arch}`;
  const archive = `${asset}.tar.gz`;
  let root: string;
  let home: string;
  let executable: string;
  let server: http.Server;
  let url: string;
  let env: NodeJS.ProcessEnv;
  let latest: string;
  let payloadVersion: string | undefined;
  let badChecksum: boolean;
  let missingRelease: boolean;
  let registryFailure: boolean;
  let registryGate: Promise<void> | undefined;
  let releaseRegistry: (() => void) | undefined;
  let requests: string[];
  const releases = new Map<string, { tarball: Buffer; checksum: string }>();

  function command(
    file: string,
    args: string[],
    extra: NodeJS.ProcessEnv = {}
  ) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(file, args, {
          env: { ...env, ...extra },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => {
          stdout += data;
        });
        child.stderr.on('data', (data) => {
          stderr += data;
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      }
    );
  }
  const cli = (args: string[], extra?: NodeJS.ProcessEnv) =>
    command(executable, args, extra);
  const dataFile = (name: string) => path.join(home, '.firecrawl', name);
  const readState = () => {
    try {
      return JSON.parse(
        fs.readFileSync(dataFile('auto-update-state.json'), 'utf8')
      );
    } catch {
      return {};
    }
  };
  async function until(check: () => boolean, message: string) {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error(
          `${message}: ${fs.existsSync(dataFile('auto-update.log')) ? fs.readFileSync(dataFile('auto-update.log'), 'utf8') : 'no log'}`
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const version = () => cli(['--version'], { FIRECRAWL_NO_UPDATE_CHECK: '1' });
  function cache(value: string) {
    fs.mkdirSync(path.dirname(dataFile('update-check.json')), {
      recursive: true,
    });
    fs.writeFileSync(
      dataFile('update-check.json'),
      JSON.stringify({
        latestVersion: value,
        checkedAt: new Date().toISOString(),
      })
    );
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-update-e2e-'));
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    fs.cpSync(path.resolve('src'), path.join(source, 'src'), {
      recursive: true,
      filter: (file) => !file.includes('__tests__'),
    });
    fs.symlinkSync(
      path.resolve('node_modules'),
      path.join(source, 'node_modules'),
      'dir'
    );
    for (const v of [current, next, nextMajor]) {
      fs.writeFileSync(
        path.join(source, 'package.json'),
        JSON.stringify({ ...packageJson, version: v })
      );
      const output = path.join(root, v);
      fs.mkdirSync(output);
      const built = spawnSync(
        'bun',
        [
          'build',
          'src/index.ts',
          '--compile',
          '--outfile',
          path.join(output, asset),
        ],
        { cwd: source, encoding: 'utf8', timeout: 120_000 }
      );
      if (built.status !== 0)
        throw new Error(`Compilation failed: ${built.stderr}`);
      {
        const packed = spawnSync('tar', ['-czf', archive, asset], {
          cwd: output,
        });
        expect(packed.status).toBe(0);
        const tarball = fs.readFileSync(path.join(output, archive));
        releases.set(v, {
          tarball,
          checksum: createHash('sha256').update(tarball).digest('hex'),
        });
      }
    }
    server = http.createServer(async (req, res) => {
      requests.push(req.url!);
      if (req.url === '/firecrawl-cli/latest') {
        await registryGate;
        res.writeHead(registryFailure ? 503 : 200, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ version: latest }));
        return;
      }
      const release = releases.get(payloadVersion ?? latest);
      if (missingRelease || !release) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === `/v${latest}/${archive}`) {
        res.end(release.tarball);
        return;
      }
      if (req.url === `/v${latest}/checksums.txt`) {
        res.end(
          `${badChecksum ? '0'.repeat(64) : release.checksum}  ${archive}\n`
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    url = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`;
  }, 180_000);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(root, 'home-'));
    executable = path.join(home, 'firecrawl');
    fs.copyFileSync(path.join(root, current, asset), executable);
    fs.chmodSync(executable, 0o755);
    env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CI: '0',
      npm_config_registry: url,
      NPM_CONFIG_REGISTRY: url,
      FIRECRAWL_RELEASES_URL: url,
      FIRECRAWL_NO_AUTO_UPDATE: '0',
      FIRECRAWL_NO_UPDATE_CHECK: '0',
      FIRECRAWL_AUTO_UPDATE_WORKER: '',
    };
    latest = next;
    payloadVersion = undefined;
    badChecksum = missingRelease = registryFailure = false;
    registryGate = undefined;
    releaseRegistry = undefined;
    requests = [];
    // Exercise elapsed observation periods through the persisted state, without
    // changing production clocks or waiting a day in CI.
    fs.mkdirSync(path.dirname(dataFile('auto-update-state.json')), {
      recursive: true,
    });
    fs.writeFileSync(
      dataFile('auto-update-state.json'),
      JSON.stringify({
        candidate: {
          version: next,
          observedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
        },
      })
    );
  });
  afterEach(async () => {
    releaseRegistry?.();
    await until(
      () => !fs.existsSync(dataFile('auto-update.lock')),
      'worker did not release its lock'
    );
    fs.rmSync(home, { recursive: true, force: true });
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('waits a full observation period and rechecks the registry before installing', async () => {
    fs.rmSync(dataFile('auto-update-state.json'));
    await cli(['--version']);
    await until(
      () => !!readState().retryAt,
      'observation delay was not recorded'
    );
    await until(
      () => !fs.existsSync(dataFile('auto-update.lock')),
      'worker did not finish'
    );
    expect(readState().candidate.version).toBe(next);
    expect(Date.parse(readState().retryAt) - Date.now()).toBeGreaterThan(
      23 * 3_600_000
    );
    expect(requests).toEqual(['/firecrawl-cli/latest']);
    expect((await version()).stdout.trim()).toBe(current);
    await cli(['--version']);
    expect(requests).toHaveLength(1);
    const past = new Date(Date.now() - 25 * 3_600_000).toISOString();
    fs.writeFileSync(
      dataFile('auto-update-state.json'),
      JSON.stringify({
        candidate: { version: next, observedAt: past },
        retryAt: past,
      })
    );
    await cli(['--version']);
    await until(
      () => readState().updated?.to === next,
      'mature release did not install'
    );
    expect(
      requests.filter((request) => request === '/firecrawl-cli/latest')
    ).toHaveLength(2);
    expect((await version()).stdout.trim()).toBe(next);
  });

  it('starts a new observation period when the candidate changes', async () => {
    latest = `${major}.${minor}.${patch + 2}`;
    await cli(['--version']);
    await until(
      () => !!readState().retryAt,
      'replacement candidate was not deferred'
    );
    expect(readState().candidate.version).toBe(latest);
    expect(requests).toEqual(['/firecrawl-cli/latest']);
    expect((await version()).stdout.trim()).toBe(current);
  });

  it('discards a withdrawn candidate before it can install', async () => {
    latest = current;
    await cli(['--version']);
    await until(
      () => fs.existsSync(dataFile('update-check.json')),
      'version was not checked'
    );
    await until(
      () => !fs.existsSync(dataFile('auto-update.lock')),
      'worker did not finish'
    );
    expect(readState().candidate).toBeUndefined();
    expect(requests).toEqual(['/firecrawl-cli/latest']);
    expect((await version()).stdout.trim()).toBe(current);
  });

  it('restores the verified previous binary offline and leaves automatic updates disabled', async () => {
    expect((await cli(['update'])).code).toBe(0);
    expect((await version()).stdout.trim()).toBe(next);
    const requestsBeforeRollback = requests.length;
    registryFailure = true;
    const result = await cli(['update', '--rollback']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Restored firecrawl ${current}`);
    expect((await cli(['--version'])).stdout.trim()).toBe(current);
    expect(requests).toHaveLength(requestsBeforeRollback);
    expect(
      fs
        .readFileSync(executable)
        .equals(fs.readFileSync(path.join(root, current, asset)))
    ).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(dataFile('auto-update.json'), 'utf8')).disabled
    ).toBe(true);
  });

  it('refuses rollback when the previous binary was modified', async () => {
    expect((await cli(['update'])).code).toBe(0);
    fs.appendFileSync(`${executable}.previous`, 'corrupt');
    const result = await cli(['update', '--rollback']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('failed verification');
    expect((await version()).stdout.trim()).toBe(next);
  });

  it('reports a missing backup after an update without changing settings', async () => {
    expect((await cli(['update'])).code).toBe(0);
    fs.rmSync(`${executable}.previous`);
    const result = await cli(['update', '--rollback']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No previous version');
    expect(fs.existsSync(dataFile('auto-update.json'))).toBe(false);
    expect((await version()).stdout.trim()).toBe(next);
  });

  it('logs an unwritable observation state and leaves the executable unchanged', async () => {
    fs.rmSync(dataFile('auto-update-state.json'));
    fs.mkdirSync(dataFile('auto-update-state.json'));
    await cli(['--version']);
    await until(
      () =>
        fs.existsSync(dataFile('auto-update.log')) &&
        fs
          .readFileSync(dataFile('auto-update.log'), 'utf8')
          .includes('Could not save update state'),
      'state write failure was not logged'
    );
    expect((await version()).stdout.trim()).toBe(current);
    expect(requests).toEqual(['/firecrawl-cli/latest']);
  });

  it('reports unavailable rollback without changing the executable', async () => {
    const result = await cli(['update', '--rollback']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No previous version');
    expect((await version()).stdout.trim()).toBe(current);
  });

  it('returns clean stdout before the registry responds, then atomically installs the verified binary', async () => {
    registryGate = new Promise<void>((resolve) => {
      releaseRegistry = resolve;
    });
    const result = await cli(['--version']);
    expect(result).toEqual({ code: 0, stdout: `${current}\n`, stderr: '' });
    await until(
      () => requests.includes('/firecrawl-cli/latest'),
      'worker did not check registry'
    );
    expect((await version()).stdout.trim()).toBe(current);
    releaseRegistry!();
    await until(
      () => readState().updated?.to === next,
      'update did not complete'
    );
    expect((await version()).stdout.trim()).toBe(next);
    expect(
      fs
        .readFileSync(executable)
        .equals(fs.readFileSync(path.join(root, next, asset)))
    ).toBe(true);
    expect(
      fs
        .readdirSync(home)
        .filter((name) => name.startsWith('.firecrawl-update-'))
    ).toEqual([]);
  });

  it('announces a completed update once on stderr and respects notice opt-out', async () => {
    await cli(['--version']);
    await until(
      () => readState().updated?.to === next,
      'update did not complete'
    );
    const terminal = (extra: NodeJS.ProcessEnv = {}) =>
      command(
        'script',
        process.platform === 'darwin'
          ? ['-q', '/dev/null', executable, '--version']
          : [
              '-q',
              '-c',
              `'${executable.replaceAll("'", "'\\''")}' --version`,
              '/dev/null',
            ],
        extra
      );
    const hidden = await terminal({ FIRECRAWL_NO_UPDATE_CHECK: '1' });
    expect(hidden.stdout).not.toContain('updated itself');
    const first = await terminal();
    expect(first.stdout).toContain(`updated itself from ${current} to ${next}`);
    expect((await terminal()).stdout).not.toContain('updated itself');
  });

  it('rejects a verified archive whose executable reports the wrong version', async () => {
    payloadVersion = current;
    const result = await cli(['update']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`expected ${next}`);
    expect((await version()).stdout.trim()).toBe(current);
  });

  it('runs only one worker when commands start concurrently', async () => {
    registryGate = new Promise<void>((resolve) => {
      releaseRegistry = resolve;
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => cli(['--version']))
    );
    expect(
      results.every(
        (result) => result.code === 0 && result.stdout.trim() === current
      )
    ).toBe(true);
    await until(
      () => requests.includes('/firecrawl-cli/latest'),
      'worker did not start'
    );
    releaseRegistry!();
    await until(
      () => readState().updated?.to === next,
      'update did not complete'
    );
    expect(
      requests.filter((request) => request === `/v${next}/${archive}`)
    ).toHaveLength(1);
  });

  it('keeps the original binary on checksum failure and backs off on later invocations', async () => {
    badChecksum = true;
    await cli(['--version']);
    await until(() => !!readState().lastError, 'checksum failure not recorded');
    expect(readState().lastError).toContain('checksum mismatch');
    expect(Date.parse(readState().retryAt) - Date.now()).toBeGreaterThan(
      23 * 3_600_000
    );
    expect((await version()).stdout.trim()).toBe(current);
    const count = requests.length;
    await cli(['--version']);
    expect(requests).toHaveLength(count);
  });

  it.each(['missing release', 'unreachable registry'])(
    'keeps the original binary and retries later after %s',
    async (failure) => {
      missingRelease = failure === 'missing release';
      registryFailure = failure === 'unreachable registry';
      await cli(['--version']);
      await until(() => !!readState().retryAt, 'retry was not recorded');
      expect(Date.parse(readState().retryAt) - Date.now()).toBeGreaterThan(
        50 * 60_000
      );
      expect((await version()).stdout.trim()).toBe(current);
    }
  );

  it.each([
    { CI: '1' },
    { FIRECRAWL_NO_AUTO_UPDATE: '1' },
    { FIRECRAWL_NO_UPDATE_CHECK: '1' },
  ])('honors environment opt-out %j', async (extra) => {
    expect((await cli(['--version'], extra)).stdout.trim()).toBe(current);
    expect(requests).toEqual([]);
    expect(fs.existsSync(dataFile('auto-update.log'))).toBe(false);
  });

  it('persists disable and enable, and explicit update works while automatic checks are off', async () => {
    expect((await cli(['update', '--disable-auto'])).code).toBe(0);
    await cli(['--version']);
    expect(requests).toEqual([]);
    expect((await cli(['update', '--enable-auto'])).code).toBe(0);
    expect(
      JSON.parse(fs.readFileSync(dataFile('auto-update.json'), 'utf8'))
    ).toEqual({});
    await cli(['update', '--disable-auto']);
    const result = await cli(['update'], {
      CI: '1',
      FIRECRAWL_NO_UPDATE_CHECK: '1',
      FIRECRAWL_NO_AUTO_UPDATE: '1',
    });
    expect(result.code, result.stderr).toBe(0);
    expect((await version()).stdout.trim()).toBe(next);
  });

  it('does not cross a major version in the background but permits an explicit update', async () => {
    latest = nextMajor;
    await cli(['--version']);
    await until(
      () => fs.existsSync(dataFile('update-check.json')),
      'version was not cached'
    );
    await until(
      () => !fs.existsSync(dataFile('auto-update.lock')),
      'worker did not finish'
    );
    expect(requests).toEqual(['/firecrawl-cli/latest']);
    expect((await version()).stdout.trim()).toBe(current);
    const result = await cli(['update']);
    expect(result.code, result.stderr).toBe(0);
    expect((await version()).stdout.trim()).toBe(nextMajor);
  });

  it('does not install a prerelease even if the registry labels it latest', async () => {
    latest = `${next}-beta.1`;
    await cli(['--version']);
    await until(
      () => fs.existsSync(dataFile('update-check.json')),
      'version was not cached'
    );
    await until(
      () => !fs.existsSync(dataFile('auto-update.lock')),
      'worker did not finish'
    );
    expect(requests).toEqual(['/firecrawl-cli/latest']);
    const count = requests.length;
    await cli(['--version']);
    expect(requests).toHaveLength(count);
    expect((await cli(['update'])).code).toBe(1);
    expect((await version()).stdout.trim()).toBe(current);
  });

  it('uses the version cache without a network check when already current', async () => {
    cache(current);
    await cli(['--version']);
    expect(requests).toEqual([]);
  });

  it('recovers an abandoned lock without delaying the command', async () => {
    fs.mkdirSync(path.dirname(dataFile('auto-update.lock')), {
      recursive: true,
    });
    fs.writeFileSync(dataFile('auto-update.lock'), '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(dataFile('auto-update.lock'), old, old);
    expect((await cli(['--version'])).stdout.trim()).toBe(current);
    await until(
      () => readState().updated?.to === next,
      'stale lock prevented update'
    );
  });

  it('returns a failure when an explicitly requested release is unavailable', async () => {
    missingRelease = true;
    const result = await cli(['update']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not published yet');
    expect((await version()).stdout.trim()).toBe(current);
  });

  it('refuses an explicit update while another updater holds the lock', async () => {
    fs.mkdirSync(path.dirname(dataFile('auto-update.lock')), {
      recursive: true,
    });
    fs.writeFileSync(
      dataFile('auto-update.lock'),
      JSON.stringify({ pid: process.pid })
    );
    try {
      const result = await cli(['update']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Another firecrawl update is running');
      expect((await version()).stdout.trim()).toBe(current);
    } finally {
      fs.rmSync(dataFile('auto-update.lock'));
    }
  });
});
