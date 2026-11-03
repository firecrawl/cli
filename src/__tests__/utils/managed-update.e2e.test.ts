import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import packageJson from '../../../package.json';
import { installationId } from '../../utils/managed-paths';

// Real npm packages, a global launcher, a local registry, and real child processes.
describe.skipIf(process.env.npm_lifecycle_event !== 'test:update')(
  'managed package updates end to end',
  () => {
    const operationTimeout = process.platform === 'win32' ? 120_000 : 30_000;
    const caseTimeout = operationTimeout * 2;
    const current = packageJson.version;
    const [major, minor, patch] = current.split('.').map(Number);
    const next = `${major}.${minor}.${patch + 1}`;
    const later = `${major}.${minor}.${patch + 2}`;
    const newest = `${major}.${minor}.${patch + 3}`;
    const dependent = `${major}.${minor}.${patch + 4}`;
    const fixtureDependency = 'firecrawl-fixture-dependency';
    const published = Date.now() - 48 * 3_600_000;
    // 1.0.1 appears after every release, so only an unbounded install selects it.
    const dependencyTimes: Record<string, number> = {
      '1.0.0': published - 24 * 3_600_000,
      '1.0.1': published + 3_600_000,
    };
    const dependencyTarballs = new Map<string, Buffer>();
    let omitPublishTime: boolean;
    let root: string;
    let installedTemplate: string;
    let home: string;
    let prefix: string;
    let basePackage: string;
    let launcher: string;
    let store: string;
    let env: NodeJS.ProcessEnv;
    let server: http.Server;
    let url: string;
    let latest: string;
    let requests: string[];
    let badIntegrity: boolean;
    let unavailable: boolean;
    let held: ChildProcess | undefined;
    let backgroundVersion: string | undefined;
    function enableBackground(version = latest) {
      env.FIRECRAWL_NO_AUTO_UPDATE = '0';
      backgroundVersion = version;
    }
    const packages = new Map<
      string,
      { manifest: Record<string, unknown>; tarball: Buffer }
    >();
    async function npm(
      args: string[],
      cwd: string,
      environment = process.env
    ): Promise<{ status: number | null; stdout: string; stderr: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.platform === 'win32' ? 'npm.cmd' : 'npm',
          args,
          {
            cwd,
            env: environment,
            shell: process.platform === 'win32',
            timeout: 120_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (data) => {
          stdout += data;
        });
        child.stderr.on('data', (data) => {
          stderr += data;
        });
        child.once('error', reject);
        child.once('close', (status) => resolve({ status, stdout, stderr }));
      });
    }
    function checkNpm(result: Awaited<ReturnType<typeof npm>>) {
      if (result.status !== 0) throw new Error(`npm failed: ${result.stderr}`);
      return result.stdout;
    }
    const pointer = () =>
      path.join(store, 'pointers', installationId(basePackage), 'current.json');
    const dataFile = (name: string) => path.join(home, '.firecrawl', name);
    function state() {
      try {
        return JSON.parse(
          fs.readFileSync(dataFile('auto-update-state.json'), 'utf8')
        );
      } catch {
        return {};
      }
    }
    async function until(predicate: () => boolean, message: string) {
      const deadline = Date.now() + operationTimeout;
      while (!predicate()) {
        if (Date.now() > deadline)
          throw new Error(`${message}: ${JSON.stringify(state())}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const readPointer = () => JSON.parse(fs.readFileSync(pointer(), 'utf8'));
    function run(
      args: string[],
      extra: NodeJS.ProcessEnv = {},
      entry = launcher
    ) {
      return new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(process.execPath, [entry, ...args], {
          env: { ...env, ...extra },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (data) => {
          stdout += data;
        });
        child.stderr.on('data', (data) => {
          stderr += data;
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), operationTimeout);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });
    }
    const version = () =>
      run(['--version'], { FIRECRAWL_NO_UPDATE_CHECK: '1' });
    function mature(version: string) {
      fs.mkdirSync(path.dirname(dataFile('auto-update-state.json')), {
        recursive: true,
      });
      fs.writeFileSync(
        dataFile('auto-update-state.json'),
        JSON.stringify({
          candidate: {
            version,
            observedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
          },
        })
      );
      fs.rmSync(dataFile('update-check.json'), { force: true });
    }

    beforeAll(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-managed-e2e-'));
      const source = path.join(root, 'source');
      fs.mkdirSync(source);
      // Build the actual distribution. Dependencies are bundled only in test
      // tarballs, so every update under test is served entirely by this registry.
      const built = spawnSync(
        process.execPath,
        [path.resolve('node_modules/typescript/bin/tsc')],
        { encoding: 'utf8' }
      );
      if (built.status !== 0) throw new Error(built.stdout + built.stderr);
      fs.cpSync(path.resolve('dist'), path.join(source, 'dist'), {
        recursive: true,
      });
      const { devDependencies, scripts, ...manifest } = packageJson;
      fs.writeFileSync(
        path.join(source, 'package.json'),
        JSON.stringify({
          ...manifest,
          bundleDependencies: Object.keys(packageJson.dependencies),
        })
      );
      const bootstrapEnv = {
        ...process.env,
        npm_config_registry: 'https://registry.npmjs.org',
        NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
      };
      checkNpm(
        await npm(
          [
            'install',
            '--ignore-scripts',
            '--no-package-lock',
            '--no-audit',
            '--no-fund',
          ],
          source,
          bootstrapEnv
        )
      );
      for (const version of [current, next, later, newest, dependent]) {
        const fixture = {
          ...manifest,
          version,
          bundleDependencies: Object.keys(packageJson.dependencies),
          ...(version === dependent && {
            dependencies: {
              ...packageJson.dependencies,
              [fixtureDependency]: '^1.0.0',
            },
          }),
        };
        fs.writeFileSync(
          path.join(source, 'package.json'),
          JSON.stringify(fixture)
        );
        const packed = JSON.parse(
          checkNpm(
            await npm(
              ['pack', '--ignore-scripts', '--json'],
              source,
              bootstrapEnv
            )
          )
        )[0];
        expect(packed.bundled.length).toBeGreaterThan(0);
        packages.set(version, {
          manifest: fixture,
          tarball: fs.readFileSync(path.join(source, packed.filename)),
        });
      }
      const dependencySource = path.join(root, 'dependency');
      fs.mkdirSync(dependencySource);
      for (const version of Object.keys(dependencyTimes)) {
        fs.writeFileSync(
          path.join(dependencySource, 'package.json'),
          JSON.stringify({ name: fixtureDependency, version })
        );
        const packed = JSON.parse(
          checkNpm(
            await npm(
              ['pack', '--ignore-scripts', '--json'],
              dependencySource,
              bootstrapEnv
            )
          )
        )[0];
        dependencyTarballs.set(
          version,
          fs.readFileSync(path.join(dependencySource, packed.filename))
        );
      }
      // Install once with real npm, then copy that installation for each case.
      // This avoids repeating slow package extraction in every Windows setup.
      installedTemplate = path.join(root, 'global-template');
      fs.mkdirSync(installedTemplate);
      fs.writeFileSync(
        path.join(installedTemplate, 'package.tgz'),
        packages.get(current)!.tarball
      );
      checkNpm(
        await npm(
          [
            'install',
            '-g',
            '--prefix',
            '.',
            'package.tgz',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
          ],
          installedTemplate,
          { ...bootstrapEnv, npm_config_prefix: installedTemplate }
        )
      );
      const templateEntry = path.join(
        installedTemplate,
        ...(process.platform === 'win32' ? [] : ['lib']),
        'node_modules',
        'firecrawl-cli',
        'dist',
        'launcher.js'
      );
      if (!fs.existsSync(templateEntry))
        throw new Error(`npm did not install the fixture at ${templateEntry}`);
      fs.rmSync(path.join(installedTemplate, 'package.tgz'));
      server = http.createServer((req, res) => {
        requests.push(req.url!);
        if (unavailable) {
          res.writeHead(503);
          res.end();
          return;
        }
        const metadata = (version: string) => {
          const pkg = packages.get(version)!;
          return {
            ...pkg.manifest,
            dist: {
              tarball: `${url}/firecrawl-cli/-/${version}.tgz`,
              integrity: `sha512-${badIntegrity ? Buffer.alloc(64).toString('base64') : createHash('sha512').update(pkg.tarball).digest('base64')}`,
            },
          };
        };
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/firecrawl-cli/latest') {
          res.end(JSON.stringify(metadata(latest)));
          return;
        }
        if (req.url === '/firecrawl-cli') {
          res.end(
            JSON.stringify({
              name: 'firecrawl-cli',
              'dist-tags': { latest },
              versions: Object.fromEntries(
                [...packages.keys()].map((v) => [v, metadata(v)])
              ),
              ...(!omitPublishTime && {
                time: Object.fromEntries(
                  [...packages.keys()].map((v) => [
                    v,
                    new Date(published).toISOString(),
                  ])
                ),
              }),
            })
          );
          return;
        }
        if (req.url === `/${fixtureDependency}`) {
          const tarball = (version: string) =>
            `${url}/${fixtureDependency}/-/${fixtureDependency}-${version}.tgz`;
          res.end(
            JSON.stringify({
              name: fixtureDependency,
              'dist-tags': { latest: '1.0.1' },
              versions: Object.fromEntries(
                [...dependencyTarballs].map(([version, bytes]) => [
                  version,
                  {
                    name: fixtureDependency,
                    version,
                    dist: {
                      tarball: tarball(version),
                      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
                    },
                  },
                ])
              ),
              time: Object.fromEntries(
                Object.entries(dependencyTimes).map(([version, time]) => [
                  version,
                  new Date(time).toISOString(),
                ])
              ),
            })
          );
          return;
        }
        const dependencyVersion = new RegExp(
          `^/${fixtureDependency}/-/${fixtureDependency}-(.+)\\.tgz$`
        ).exec(req.url!)?.[1];
        if (dependencyVersion && dependencyTarballs.has(dependencyVersion)) {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(dependencyTarballs.get(dependencyVersion));
          return;
        }
        const version = /^\/firecrawl-cli\/-\/(.+)\.tgz$/.exec(req.url!)?.[1];
        if (version && packages.has(version)) {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(packages.get(version)!.tarball);
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

    beforeEach(async () => {
      backgroundVersion = undefined;
      home = fs.mkdtempSync(path.join(root, 'home with spaces-'));
      prefix = path.join(home, 'global');
      fs.cpSync(installedTemplate, prefix, {
        recursive: true,
        verbatimSymlinks: true,
      });
      env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CI: '0',
        npm_config_registry: url,
        NPM_CONFIG_REGISTRY: url,
        npm_config_cache: path.join(home, 'npm-cache'),
        NPM_CONFIG_CACHE: path.join(home, 'npm-cache'),
        npm_config_prefix: prefix,
        NPM_CONFIG_PREFIX: prefix,
        FIRECRAWL_NO_UPDATE_CHECK: '0',
        FIRECRAWL_NO_AUTO_UPDATE: '1',
        FIRECRAWL_AUTO_UPDATE_WORKER: '',
      };
      delete env.FIRECRAWL_API_KEY;
      // Windows can inherit uppercase npm settings from its package runner.
      // Confirm the per-case cache before asserting exact download counts.
      fs.mkdirSync(env.npm_config_cache!);
      const cache = checkNpm(
        await npm(['config', 'get', 'cache'], prefix, env)
      ).trim();
      expect(fs.realpathSync(cache)).toBe(
        fs.realpathSync(env.npm_config_cache!)
      );
      latest = next;
      requests = [];
      badIntegrity = unavailable = omitPublishTime = false;
      basePackage = path.join(
        prefix,
        ...(process.platform === 'win32' ? [] : ['lib']),
        'node_modules',
        'firecrawl-cli'
      );
      launcher = path.join(basePackage, 'dist', 'launcher.js');
      store = path.join(
        home,
        '.firecrawl',
        'versions',
        `node-${process.versions.node.split('.')[0]}`
      );
      requests = [];
      mature(next);
    }, operationTimeout);
    afterEach(async () => {
      // Background cases must report completion, not just an absent lock:
      // a detached worker can acquire its lock after its parent has exited.
      if (backgroundVersion)
        await until(
          () =>
            state().updated?.to === backgroundVersion || !!state().lastError,
          'background worker did not report completion'
        );
      if (held) {
        const child = held;
        held = undefined;
        if (child.exitCode === null && child.signalCode === null)
          await new Promise((resolve) => {
            child.once('close', resolve);
            child.kill('SIGKILL');
          });
      }
      await until(
        () => !fs.existsSync(dataFile('auto-update.lock')),
        'worker did not finish'
      );
      fs.rmSync(home, { recursive: true, force: true });
    }, operationTimeout);
    afterAll(async () => {
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it(
      'updates a real global npm installation while preserving the launcher and base package',
      { timeout: caseTimeout },
      async () => {
        enableBackground();
        const launcherBytes = fs.readFileSync(launcher);
        const baseBytes = fs.readFileSync(
          path.join(basePackage, 'dist', 'index.js')
        );
        expect(await run(['--version'])).toEqual({
          code: 0,
          stdout: `${current}\n`,
          stderr: '',
        });
        await until(
          () => state().updated?.to === next,
          'package update did not finish'
        );
        expect(readPointer().version).toBe(next);
        expect((await version()).stdout.trim()).toBe(next);
        expect(fs.readFileSync(launcher).equals(launcherBytes)).toBe(true);
        expect(
          fs
            .readFileSync(path.join(basePackage, 'dist', 'index.js'))
            .equals(baseBytes)
        ).toBe(true);
        expect(
          JSON.parse(
            fs.readFileSync(path.join(basePackage, 'package.json'), 'utf8')
          ).version
        ).toBe(current);
        expect(
          fs.readdirSync(store).some((name) => name.startsWith('.install-'))
        ).toBe(false);
        expect(
          requests.some((request) => request.endsWith(`/${next}.tgz`))
        ).toBe(true);
      }
    );

    it(
      'keeps a running older release through two updates, then removes it after its process exits',
      { timeout: caseTimeout * 2 },
      async () => {
        expect((await run(['update'])).code).toBe(0);
        const oldRoot = path.join(store, next, 'node_modules', 'firecrawl-cli');
        const reader = path.join(home, 'reader.cjs');
        const countFile = path.join(home, 'reads');
        fs.writeFileSync(
          reader,
          `const fs=require('fs'),path=require('path'); let reads=0; setInterval(()=>{ const pkg=path.dirname(path.dirname(process.argv[1])); const file=pkg+'/dist/utils/url.js'; delete require.cache[require.resolve(file)]; require(file).normalizeUrl('example.com'); const count=process.env.FIRECRAWL_TEST_READS; fs.writeFileSync(count+'.tmp',String(++reads)); fs.renameSync(count+'.tmp',count); },10);`
        );
        held = spawn(process.execPath, [launcher, 'version'], {
          env: {
            ...env,
            NODE_OPTIONS: '--require ' + JSON.stringify(reader),
            FIRECRAWL_TEST_READS: countFile,
            FIRECRAWL_NO_UPDATE_CHECK: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        await until(() => fs.existsSync(countFile), 'held CLI did not start');
        const before = Number(fs.readFileSync(countFile, 'utf8'));
        latest = later;
        expect((await run(['update'])).code).toBe(0);
        latest = newest;
        expect((await run(['update'])).code).toBe(0);
        expect((await version()).stdout.trim()).toBe(newest);
        expect(held.exitCode).toBeNull();
        expect(Number(fs.readFileSync(countFile, 'utf8'))).toBeGreaterThan(
          before + 10
        );
        expect(fs.existsSync(oldRoot)).toBe(true);
        const child = held;
        held = undefined;
        if (child.exitCode === null && child.signalCode === null)
          await new Promise((resolve) => {
            child.once('close', resolve);
            child.kill('SIGKILL');
          });
        expect((await run(['update'])).code).toBe(0);
        expect(fs.existsSync(oldRoot)).toBe(false);
        expect(
          fs
            .readdirSync(store)
            .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
            .sort()
        ).toEqual([later, newest].sort());
        expect((await run(['update', '--rollback'])).code).toBe(0);
        expect((await version()).stdout.trim()).toBe(later);
      }
    );

    it(
      'honors an explicit npm reinstall while disabled without reverting merely on disable',
      { timeout: caseTimeout },
      async () => {
        expect((await run(['update'])).code).toBe(0);
        expect((await run(['update', '--disable-auto'])).code).toBe(0);
        expect((await version()).stdout.trim()).toBe(next);
        fs.writeFileSync(
          path.join(prefix, 'package.tgz'),
          packages.get(current)!.tarball
        );
        checkNpm(
          await npm(
            [
              'install',
              '-g',
              '--prefix',
              '.',
              'package.tgz',
              '--ignore-scripts',
              '--no-audit',
              '--no-fund',
            ],
            prefix,
            env
          )
        );
        expect((await run(['--version'])).stdout.trim()).toBe(current);
        expect((await run(['update', '--rollback'])).code).toBe(1);
        expect((await run(['update'])).code).toBe(0);
        expect((await version()).stdout.trim()).toBe(next);
      }
    );

    it(
      'preserves selection when another hardlink changes package metadata',
      { timeout: caseTimeout },
      async () => {
        expect((await run(['update'])).code).toBe(0);
        const link = path.join(home, 'shared-manifest.json');
        fs.linkSync(path.join(basePackage, 'package.json'), link);
        expect((await version()).stdout.trim()).toBe(next);
        fs.rmSync(link);
        expect((await version()).stdout.trim()).toBe(next);
      }
    );

    it(
      'keeps separate global selections and rollback releases while reclaiming removed installs',
      { timeout: caseTimeout * 2 },
      async () => {
        expect((await run(['update'])).code).toBe(0);
        latest = later;
        expect((await run(['update'])).code).toBe(0);
        const second = path.join(
          home,
          'second',
          ...(process.platform === 'win32' ? [] : ['lib']),
          'node_modules',
          'firecrawl-cli'
        );
        fs.cpSync(installedTemplate, path.join(home, 'second'), {
          recursive: true,
          verbatimSymlinks: true,
        });
        const secondLauncher = path.join(second, 'dist/launcher.js');
        latest = newest;
        const result = await run(['update'], {}, secondLauncher);
        expect(result.code, result.stdout + result.stderr).toBe(0);
        expect((await version()).stdout.trim()).toBe(later);
        expect(
          (await run(['--version'], {}, secondLauncher)).stdout.trim()
        ).toBe(newest);
        expect(fs.existsSync(path.join(store, next))).toBe(true);
        expect((await run(['update', '--rollback'])).code).toBe(0);
        expect((await version()).stdout.trim()).toBe(next);
        expect(
          (await run(['--version'], {}, secondLauncher)).stdout.trim()
        ).toBe(newest);
        const removedPointer = pointer();
        fs.rmSync(basePackage, { recursive: true });
        expect((await run(['update'], {}, secondLauncher)).code).toBe(0);
        expect(fs.existsSync(removedPointer)).toBe(false);
        expect(fs.existsSync(path.join(store, next))).toBe(false);
        expect(fs.existsSync(path.join(store, later))).toBe(false);
      }
    );

    it(
      'reports an already current installation even while another updater holds the lock',
      { timeout: caseTimeout },
      async () => {
        latest = current;
        const lock = dataFile('auto-update.lock');
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
        try {
          const result = await run(['update']);
          expect(result.code).toBe(0);
          expect(result.stdout).toContain('is up to date');
          expect(fs.existsSync(lock)).toBe(true);
        } finally {
          fs.rmSync(lock, { force: true });
        }
      }
    );

    it(
      'reuses a saved release across Node patch changes and checks its engine range',
      { timeout: caseTimeout },
      async () => {
        expect((await run(['update'])).code).toBe(0);
        const runtime = process.versions.node.split('.').map(Number);
        const patchVersion = `${runtime[0]}.${runtime[1]}.${runtime[2] + 1}`;
        const shim = path.join(home, 'runtime.cjs');
        fs.writeFileSync(
          shim,
          `Object.defineProperty(process.versions,'node',{value:${JSON.stringify(patchVersion)}});`
        );
        const before = requests.length;
        expect(
          (
            await run(['--version'], {
              NODE_OPTIONS: '--require ' + JSON.stringify(shim),
              FIRECRAWL_NO_UPDATE_CHECK: '1',
            })
          ).stdout.trim()
        ).toBe(next);
        expect(requests).toHaveLength(before);
        const manifestPath = path.join(
          store,
          next,
          'node_modules/firecrawl-cli/package.json'
        );
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({ ...manifest, engines: { node: '>=99.0.0' } })
        );
        expect((await version()).stdout.trim()).toBe(current);
      }
    );

    it(
      'respects cleanup markers and recovers a marker abandoned before reinstall',
      { timeout: caseTimeout },
      async () => {
        expect((await run(['update'])).code).toBe(0);
        fs.writeFileSync(
          path.join(store, `.deleting-${next}`),
          'cleanup in progress'
        );
        expect((await version()).stdout.trim()).toBe(current);
        expect(fs.readdirSync(path.join(store, next, '.leases'))).toEqual([]);
        fs.rmSync(path.join(store, `.deleting-${next}`));
        expect((await version()).stdout.trim()).toBe(next);
        // Cleanup deleted an inactive version, then exited before its marker.
        fs.writeFileSync(path.join(store, `.deleting-${later}`), 'abandoned');
        latest = later;
        expect((await run(['update'])).code).toBe(0);
        expect((await version()).stdout.trim()).toBe(later);
        expect(fs.existsSync(path.join(store, `.deleting-${later}`))).toBe(
          false
        );
      }
    );

    it(
      'reclaims old abandoned staging but retains live and recent staging',
      { timeout: caseTimeout },
      async () => {
        latest = current;
        const output = path.join(home, 'stage-path');
        const script = `const fs=require('fs'); const lifecycle=require(process.argv[1]); const prefix=lifecycle.stagingPrefix(); fs.mkdirSync(require('path').dirname(prefix),{recursive:true}); const dir=fs.mkdtempSync(prefix); fs.writeFileSync(dir+'/partial','unfinished download'); fs.writeFileSync(process.argv[2],dir); setInterval(()=>{},1000);`;
        held = spawn(
          process.execPath,
          [
            '-e',
            script,
            path.join(basePackage, 'dist/utils/managed-lifecycle.js'),
            output,
          ],
          { env, stdio: 'ignore' }
        );
        await until(() => fs.existsSync(output), 'staging owner did not start');
        const staging = fs.readFileSync(output, 'utf8');
        const old = new Date(Date.now() - 48 * 3600000);
        fs.utimesSync(staging, old, old);
        expect((await run(['update'])).code).toBe(0);
        expect(fs.existsSync(staging)).toBe(true);
        const child = held;
        held = undefined;
        if (child.exitCode === null && child.signalCode === null)
          await new Promise((resolve) => {
            child.once('close', resolve);
            child.kill('SIGKILL');
          });
        const recent = staging + '-recent';
        fs.mkdirSync(recent);
        expect((await run(['update'])).code).toBe(0);
        expect(fs.existsSync(staging)).toBe(false);
        expect(fs.existsSync(recent)).toBe(true);
      }
    );

    it(
      'gives the original package manager command when npm is unavailable',
      { timeout: caseTimeout },
      async () => {
        for (const [kind, location, command] of [
          [
            'pnpm',
            path.join(home, 'pnpm/global/5/node_modules/firecrawl-cli'),
            'pnpm add -g',
          ],
          [
            'bun',
            path.join(home, '.bun/install/global/node_modules/firecrawl-cli'),
            'bun add -g',
          ],
          [
            'yarn',
            path.join(home, '.config/yarn/global/node_modules/firecrawl-cli'),
            'yarn global add',
          ],
        ]) {
          fs.cpSync(basePackage, location, { recursive: true });
          const result = await run(
            ['update'],
            { PATH: '' },
            path.join(location, 'dist/launcher.js')
          );
          expect(result.code, kind).toBe(1);
          expect(result.stderr).toContain('require npm on PATH');
          expect(result.stderr).toContain(`${command} firecrawl-cli@latest`);
        }
      }
    );

    it(
      'installs only once when multiple global invocations start together',
      { timeout: caseTimeout },
      async () => {
        enableBackground();
        const results = await Promise.all(
          Array.from({ length: 5 }, () => run(['--version']))
        );
        expect(results.every((result) => result.code === 0)).toBe(true);
        await until(
          () => state().updated?.to === next,
          'concurrent update did not finish'
        );
        expect(
          requests.filter((request) => request.endsWith(`/${next}.tgz`))
        ).toHaveLength(1);
        expect((await version()).stdout.trim()).toBe(next);
      }
    );

    it(
      'preserves the old installation if npm rejects the release integrity',
      { timeout: caseTimeout },
      async () => {
        badIntegrity = true;
        // Disable npm retry delays while retaining its real integrity validation.
        env.npm_config_fetch_retries = '0';
        const result = await run(['update']);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('npm install failed');
        expect(fs.existsSync(pointer())).toBe(false);
        expect((await version()).stdout.trim()).toBe(current);
      }
    );

    it(
      'rolls back offline to the global installation and does not immediately reinstall',
      { timeout: caseTimeout },
      async () => {
        expect((await run(['update'])).code).toBe(0);
        const before = requests.length;
        unavailable = true;
        const skill = path.join(home, '.agents', 'skills', 'firecrawl');
        fs.mkdirSync(skill, { recursive: true });
        fs.writeFileSync(path.join(skill, 'SKILL.md'), 'Installed test skill');
        fs.writeFileSync(
          path.join(home, '.agents', '.skill-lock.json'),
          JSON.stringify({
            skills: { firecrawl: { source: 'firecrawl/skills' } },
          })
        );
        const networkMarker = path.join(home, 'network-attempted');
        const offline = path.join(home, 'offline-terminal.cjs');
        fs.writeFileSync(
          offline,
          `Object.defineProperty(process.stderr,'isTTY',{value:true}); global.fetch=()=>{require('fs').appendFileSync(process.env.FIRECRAWL_TEST_NETWORK_MARKER,'fetch'); return Promise.reject(new Error('offline'));};`
        );
        const result = await run(['update', '--rollback'], {
          NODE_OPTIONS: '--require ' + JSON.stringify(offline),
          FIRECRAWL_TEST_NETWORK_MARKER: networkMarker,
        });
        expect(result.code, result.stderr).toBe(0);
        expect(fs.existsSync(networkMarker)).toBe(false);
        expect((await run(['--version'])).stdout.trim()).toBe(current);
        expect(requests).toHaveLength(before);
        expect(
          JSON.parse(fs.readFileSync(dataFile('auto-update.json'), 'utf8'))
            .disabled
        ).toBe(true);
      }
    );

    it(
      'resolves dependencies as the registry stood when the release was published',
      { timeout: caseTimeout },
      async () => {
        latest = dependent;
        const registryFailure = path.join(home, 'registry-failure.cjs');
        for (const [response, message] of [
          [
            "throw new Error('registry connection failed')",
            'registry connection failed',
          ],
          ['return new Response(null,{status:503})', 'HTTP 503'],
        ]) {
          fs.writeFileSync(
            registryFailure,
            `const original=global.fetch; global.fetch=async(input,...args)=>{if(String(input)===${JSON.stringify(`${url}/firecrawl-cli`)}){${response}}return original(input,...args);};`
          );
          const failed = await run(['update'], {
            NODE_OPTIONS: '--require ' + JSON.stringify(registryFailure),
          });
          expect(failed.code).toBe(1);
          expect(failed.stderr).toContain(message);
          expect(fs.existsSync(pointer())).toBe(false);
        }
        omitPublishTime = true;
        const unbounded = await run(['update']);
        expect(unbounded.code).toBe(1);
        expect(unbounded.stderr).toContain('did not report when');
        expect(fs.existsSync(pointer())).toBe(false);
        omitPublishTime = false;
        const result = await run(['update']);
        expect(result.code, result.stderr).toBe(0);
        expect((await version()).stdout.trim()).toBe(dependent);
        expect(
          JSON.parse(
            fs.readFileSync(
              path.join(
                store,
                dependent,
                'node_modules',
                fixtureDependency,
                'package.json'
              ),
              'utf8'
            )
          ).version
        ).toBe('1.0.0');
      }
    );

    it.each([
      { rootOptions: [] },
      { rootOptions: ['--api-key', 'update'] },
      { rootOptions: ['--api-url=http://localhost'] },
      { rootOptions: ['-kupdate', '--enable', 'alexandria'] },
      { rootOptions: ['--status'] },
    ])(
      'rolls back from the launcher when the active release cannot start with root options %j',
      { timeout: caseTimeout },
      async ({ rootOptions }) => {
        expect((await run(['update'])).code).toBe(0);
        fs.writeFileSync(
          path.join(
            store,
            next,
            'node_modules',
            'firecrawl-cli',
            'dist',
            'index.js'
          ),
          "throw new Error('broken release');"
        );
        expect((await version()).code).not.toBe(0);
        expect(
          (await run(['--api-key', 'update', 'version', '--rollback'])).stderr
        ).toContain('broken release');
        expect(
          (await run(['scrape', 'update', '--rollback'])).stderr
        ).toContain('broken release');
        const result = await run([...rootOptions, 'update', '--rollback']);
        expect(result.code, result.stderr).toBe(0);
        expect((await version()).stdout.trim()).toBe(current);
      }
    );

    it(
      'restores the previous managed release after a second update',
      { timeout: caseTimeout },
      async () => {
        expect((await run(['update'])).code).toBe(0);
        latest = later;
        expect((await run(['update'])).code).toBe(0);
        expect((await version()).stdout.trim()).toBe(later);
        expect((await run(['update', '--rollback'])).code).toBe(0);
        expect((await version()).stdout.trim()).toBe(next);
      }
    );

    it(
      'honors persistent opt-outs for npm and supports explicit updates while disabled',
      { timeout: caseTimeout },
      async () => {
        env.FIRECRAWL_NO_AUTO_UPDATE = '0';
        expect((await run(['update', '--disable-auto'])).code).toBe(0);
        await run(['--version']);
        expect(requests).toEqual([]);
        expect((await run(['update'])).code).toBe(0);
        expect((await version()).stdout.trim()).toBe(next);
        expect((await run(['update', '--enable-auto'])).code).toBe(0);
      }
    );

    it(
      'does not roll back an inactive pointer or change settings on an unavailable rollback',
      { timeout: caseTimeout },
      async () => {
        expect((await run(['update', '--rollback'])).code).toBe(1);
        expect(fs.existsSync(dataFile('auto-update.json'))).toBe(false);
        expect((await run(['update'])).code).toBe(0);
        // A newer base installation takes precedence over the saved managed pointer.
        const manifestPath = path.join(basePackage, 'package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({ ...manifest, version: later })
        );
        expect((await version()).stdout.trim()).toBe(later);
        expect((await run(['update', '--rollback'])).code).toBe(1);
        expect(fs.existsSync(dataFile('auto-update.json'))).toBe(false);
        expect(readPointer().version).toBe(next);
      }
    );

    it(
      'reports the npm prerequisite without modifying the active installation',
      async () => {
        const result = await run(['update'], { PATH: '' });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('require npm on PATH');
        expect(fs.existsSync(pointer())).toBe(false);
        expect((await version()).stdout.trim()).toBe(current);
      },
      operationTimeout
    );

    it(
      'restores the opt-out preference when rollback activation fails',
      async () => {
        expect((await run(['update'])).code).toBe(0);
        // Inject an OS failure only when rollback removes the current pointer.
        const fault = path.join(home, 'rollback-fault.cjs');
        fs.writeFileSync(
          fault,
          `const fs=require('fs'); const original=fs.rmSync; fs.rmSync=function(file,...args){ if(String(file).endsWith('current.json')) throw Object.assign(new Error('injected permission failure'),{code:'EACCES'}); return original.call(this,file,...args); };`
        );
        const result = await run(['update', '--rollback'], {
          NODE_OPTIONS: '--require ' + JSON.stringify(fault),
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('injected permission failure');
        expect(fs.existsSync(dataFile('auto-update.json'))).toBe(false);
        expect((await version()).stdout.trim()).toBe(next);
      },
      operationTimeout
    );

    it(
      'ignores invalid current pointers and keeps the base launcher usable',
      { timeout: caseTimeout },
      async () => {
        fs.mkdirSync(store, { recursive: true });
        for (const pointerValue of [
          { version: '../../outside' },
          { version: next },
          { version: 42 },
        ]) {
          fs.mkdirSync(path.dirname(pointer()), { recursive: true });
          fs.writeFileSync(pointer(), JSON.stringify(pointerValue));
          expect((await version()).stdout.trim()).toBe(current);
        }
      }
    );

    it(
      'keeps project-local and package-runner installations pinned, rejects enable, and saves the shared opt-out',
      { timeout: caseTimeout },
      async () => {
        expect((await run(['update'])).code).toBe(0);
        for (const location of [
          path.join(home, 'project', 'node_modules', 'firecrawl-cli'),
          path.join(
            home,
            '.npm',
            '_npx',
            'test',
            'node_modules',
            'firecrawl-cli'
          ),
        ]) {
          fs.cpSync(basePackage, location, { recursive: true });
          const localLauncher = path.join(location, 'dist', 'launcher.js');
          expect(
            (
              await run(
                ['--version'],
                { FIRECRAWL_NO_UPDATE_CHECK: '1' },
                localLauncher
              )
            ).stdout.trim()
          ).toBe(current);
          fs.rmSync(dataFile('auto-update.json'), { force: true });
          expect(
            (await run(['update', '--enable-auto'], {}, localLauncher)).code
          ).toBe(1);
          expect(fs.existsSync(dataFile('auto-update.json'))).toBe(false);
          expect(
            (await run(['update', '--disable-auto'], {}, localLauncher)).code
          ).toBe(0);
          expect(
            JSON.parse(fs.readFileSync(dataFile('auto-update.json'), 'utf8'))
              .disabled
          ).toBe(true);
        }
      }
    );
  }
);
