import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer, type Server } from 'http';
import { stripVTControlCharacters } from 'util';
import { installSkillsNative } from '../../commands/skills-native';
import {
  handleSetupCommand,
  installSkillsForAgent,
} from '../../commands/setup';
import { maybeShowSkillUpdateNotice } from '../../utils/skill-update-notice';
import { CATALOG_TREE_URL } from '../../utils/skill-catalog';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: vi.fn(),
}));

describe('skill update lifecycle', () => {
  let root: string;
  let home: string;
  let repo: string;
  let server: Server;
  let url: string;
  let response: unknown;
  let status: number;
  let requests: number;
  let stalled: boolean;
  let stderr = {
    isTTY: true,
    write: vi.fn((_chunk: string | Uint8Array) => true),
  };
  const now = new Date('2026-01-01T00:00:00Z');
  const originalFetch = globalThis.fetch;

  function git(...args: string[]): string {
    return childProcess.execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
    });
  }

  function write(relative: string, content: string): void {
    const file = path.join(repo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  function skill(family: string, name: string): void {
    write(
      `skills/${family}/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Fixture workflow\n---\nRun the workflow.\n`
    );
  }

  function publish(): void {
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'Update fixture'
    );
    response = {
      truncated: false,
      tree: git('ls-tree', '-rz', 'HEAD')
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const [header, file] = line.split('\t');
          const [mode, type, sha] = header.split(' ');
          return { mode, type, sha, path: file };
        }),
    };
  }

  async function install(): Promise<void> {
    await installSkillsNative('firecrawl/skills', {
      family: 'workflows',
      // Represents a CLI whose built-in list predates later catalog additions.
      skills: ['firecrawl-workflows'],
      agent: 'claude-code',
      quiet: true,
    });
  }

  function mockNpxInstall(names: string[]): void {
    const execFile = childProcess.execFileSync;
    const exec = vi.mocked(childProcess.execSync).getMockImplementation()!;
    vi.mocked(childProcess.execSync).mockImplementation((command, options) =>
      command === 'npx --version'
        ? Buffer.from('10.0.0')
        : exec(command, options)
    );
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(
      (command, args, options) => {
        if (command === 'git') return execFile(command, args, options);
        const lockPath = process.env.XDG_STATE_HOME
          ? path.join(process.env.XDG_STATE_HOME, 'skills/.skill-lock.json')
          : path.join(home, '.agents/.skill-lock.json');
        const lock = fs.existsSync(lockPath)
          ? JSON.parse(fs.readFileSync(lockPath, 'utf8'))
          : { version: 3, skills: {} };
        for (const name of names) {
          const family = name === 'firecrawl' ? 'core' : 'workflows';
          const destination = path.join(home, '.agents/skills', name);
          fs.mkdirSync(destination, { recursive: true });
          fs.cpSync(path.join(repo, 'skills', family, name), destination, {
            recursive: true,
          });
          lock.skills[name] = { source: 'firecrawl/skills' };
        }
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, JSON.stringify(lock));
        return Buffer.from('Installed');
      }
    );
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-skill-updates-'));
    home = path.join(root, 'home');
    repo = path.join(root, 'catalog');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    git('init', '-q');
    skill('core', 'firecrawl');
    skill('workflows', 'firecrawl-workflows');
    skill('workflows', 'firecrawl-lead-research');
    write(
      'skills/workflows/firecrawl-lead-research/references/brief.md',
      'Original reference\n'
    );
    publish();
    status = 200;
    requests = 0;
    stalled = false;
    server = createServer((_req, res) => {
      requests++;
      if (stalled) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No fixture port');
    url = `http://127.0.0.1:${address.port}`;
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.mocked(childProcess.execSync).mockImplementation((command) => {
      const clone = command.match(
        /^git clone --depth 1 "https:\/\/github.com\/firecrawl\/skills.git" "(.+)"$/
      );
      if (clone) {
        return childProcess.execFileSync(
          'git',
          ['clone', '--quiet', repo, clone[1]],
          { stdio: 'pipe' }
        );
      }
      if (command === 'git --version')
        return childProcess.execFileSync('git', ['--version']);
      throw new Error(`Unexpected fixture command: ${command}`);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        expect(input).toBe(CATALOG_TREE_URL);
        return originalFetch(url, init);
      })
    );
    vi.stubEnv('FIRECRAWL_NO_UPDATE_CHECK', '');
    vi.stubEnv('XDG_STATE_HOME', undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stderr = {
      isTTY: true,
      write: vi.fn((_chunk: string | Uint8Array) => true),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('detects reference edits and new workflows, throttles notices, then clears after explicit refresh', async () => {
    await install();
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() - 21 * 60 * 60 * 1000),
      stderr,
    });
    requests = 0;
    const installed = path.join(home, '.agents/skills');
    expect(fs.existsSync(path.join(installed, 'firecrawl'))).toBe(false);
    const reference = path.join(
      installed,
      'firecrawl-lead-research/references/brief.md'
    );
    const lockPath = path.join(home, '.agents/.skill-lock.json');
    const lockBefore = fs.readFileSync(lockPath, 'utf8');
    write(
      'skills/workflows/firecrawl-lead-research/references/brief.md',
      'Updated reference\n'
    );
    skill('workflows', 'firecrawl-new-workflow');
    publish();

    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('FORCE_COLOR', '1');
    await maybeShowSkillUpdateNotice({ now, stderr });
    expect(stderr.write).toHaveBeenCalledOnce();
    const coloredNotice = String(stderr.write.mock.calls[0][0]);
    const notice = stripVTControlCharacters(coloredNotice);
    expect(notice.startsWith('╭')).toBe(true);
    expect(notice.trimEnd().endsWith('╯')).toBe(true);
    expect(notice).toContain('✨ Skill updates available!');
    expect(notice).toContain('Run firecrawl setup workflows');
    expect(notice).toContain(
      'https://github.com/firecrawl/skills/commits/main/'
    );
    expect(coloredNotice).toContain('\x1b[1;36mSkill updates available!');
    expect(fs.readFileSync(reference, 'utf8')).toBe('Original reference\n');
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(lockBefore);
    expect(requests).toBe(1);

    stderr.write.mockClear();
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 60 * 60 * 1000),
      stderr,
    });
    expect(stderr.write).not.toHaveBeenCalled();
    vi.stubEnv('NO_COLOR', '1');
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 13 * 60 * 60 * 1000),
      stderr,
    });
    expect(stderr.write).toHaveBeenCalledOnce();
    expect(String(stderr.write.mock.calls[0][0])).not.toContain('\x1b[');
    expect(requests).toBe(1);

    await handleSetupCommand('workflows', {
      nativeSkills: true,
      agent: 'claude-code',
      quiet: true,
      skipAuthOffer: true,
    });
    expect(fs.readFileSync(reference, 'utf8')).toBe('Updated reference\n');
    expect(
      fs.existsSync(path.join(installed, 'firecrawl-new-workflow/SKILL.md'))
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(home, '.claude/skills/firecrawl-new-workflow/SKILL.md')
      )
    ).toBe(true);
    expect(fs.existsSync(path.join(installed, 'firecrawl'))).toBe(false);
    stderr.write.mockClear();
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 14 * 60 * 60 * 1000),
      stderr,
    });
    expect(stderr.write).not.toHaveBeenCalled();
    expect(requests).toBe(2);
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 21 * 60 * 60 * 1000),
      stderr,
    });
    expect(requests).toBe(2);
    expect(stderr.write).not.toHaveBeenCalled();
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 35 * 60 * 60 * 1000),
      stderr,
    });
    expect(requests).toBe(3);
  });

  it('stays quiet and avoids network access for non-interactive, opted-out and fresh installations', async () => {
    await maybeShowSkillUpdateNotice({ now, stderr });
    expect(requests).toBe(0);
    await install();
    stderr.isTTY = false;
    await maybeShowSkillUpdateNotice({ now, stderr });
    stderr.isTTY = true;
    vi.stubEnv('FIRECRAWL_NO_UPDATE_CHECK', '1');
    await maybeShowSkillUpdateNotice({ now, stderr });
    expect(requests).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('treats CRLF checkouts as current and invalidates a cached catalog after refresh', async () => {
    await install();
    const file = path.join(
      home,
      '.agents/skills/firecrawl-lead-research/SKILL.md'
    );
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n')
    );
    await maybeShowSkillUpdateNotice({ now, stderr });
    expect(stderr.write).not.toHaveBeenCalled();
    write(
      'skills/workflows/firecrawl-lead-research/references/brief.md',
      'Newer than cached catalog\n'
    );
    publish();
    await install();
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 1000),
      stderr,
    });
    expect(requests).toBe(2);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('preserves the additions baseline when a post-install catalog refresh fails', async () => {
    await install();
    await maybeShowSkillUpdateNotice({ now, stderr });
    write(
      'skills/workflows/firecrawl-lead-research/references/brief.md',
      'Updated reference\n'
    );
    publish();
    await install();
    status = 503;
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 1000),
      stderr,
    });
    skill('workflows', 'firecrawl-new-workflow');
    publish();
    status = 200;
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 61 * 60 * 1000),
      stderr,
    });
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('firecrawl setup workflows')
    );
  });

  it('handles failed catalog requests silently and backs off before retrying', async () => {
    await install();
    status = 429;
    await expect(
      maybeShowSkillUpdateNotice({ now, stderr })
    ).resolves.toBeUndefined();
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 1000),
      stderr,
    });
    expect(requests).toBe(1);
    status = 200;
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 61 * 60 * 1000),
      stderr,
    });
    expect(requests).toBe(2);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it.each(['checkedAt', 'retryAt', 'lastShownAt'] as const)(
    'recovers from an invalid cached %s',
    async (key) => {
      await install();
      write(
        'skills/workflows/firecrawl-lead-research/references/brief.md',
        'Changed reference\n'
      );
      publish();
      await maybeShowSkillUpdateNotice({ now, stderr });
      const cachePath = path.join(home, '.firecrawl/skill-update-check.json');
      const original = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

      for (const invalid of [
        '"invalid"',
        '"123"',
        '{}',
        'true',
        'null',
        '1e400',
      ]) {
        const cache = { ...original };
        if (key === 'retryAt') cache.checkedAt = 0;
        delete cache[key];
        fs.writeFileSync(
          cachePath,
          `${JSON.stringify(cache).slice(0, -1)},"${key}":${invalid}}`
        );
        requests = 0;
        stderr.write.mockClear();
        await maybeShowSkillUpdateNotice({ now, stderr });
        expect(requests).toBe(key === 'lastShownAt' ? 0 : 1);
        expect(stderr.write).toHaveBeenCalledTimes(
          key === 'lastShownAt' ? 1 : 0
        );
        const repaired = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (key === 'retryAt') expect(repaired).not.toHaveProperty(key);
        else expect(repaired[key]).toBe(now.getTime());
      }
    }
  );

  it.each(['[]', '{"baseline":["invalid"]}'])(
    'repairs malformed cache %s and respects the notice cooldown',
    async (invalidCache) => {
      await install();
      write(
        'skills/workflows/firecrawl-lead-research/references/brief.md',
        'Changed reference\n'
      );
      publish();
      const cachePath = path.join(home, '.firecrawl/skill-update-check.json');
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      skill('workflows', 'firecrawl-shop');
      publish();
      fs.writeFileSync(cachePath, invalidCache);
      await maybeShowSkillUpdateNotice({ now, stderr });
      await maybeShowSkillUpdateNotice({ now, stderr });
      expect(requests).toBe(1);
      expect(stderr.write).toHaveBeenCalledOnce();
      expect(stderr.write).toHaveBeenCalledWith(
        expect.stringContaining('firecrawl setup workflows')
      );
      expect(
        Array.isArray(JSON.parse(fs.readFileSync(cachePath, 'utf8')))
      ).toBe(false);
    }
  );

  it('serializes concurrent notice checks and recovers an abandoned lock', async () => {
    await install();
    write(
      'skills/workflows/firecrawl-lead-research/references/brief.md',
      'Changed reference\n'
    );
    publish();
    const lockPath = path.join(home, '.firecrawl/skill-update-check.json.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, stale, stale);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        maybeShowSkillUpdateNotice({ now, stderr })
      )
    );
    expect(requests).toBe(1);
    expect(stderr.write).toHaveBeenCalledOnce();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not nag about skipped skills and offers a single family refresh command', async () => {
    skill('workflows', 'firecrawl-shop');
    publish();
    await install();
    fs.rmSync(path.join(home, '.agents/skills/firecrawl-shop'), {
      recursive: true,
    });
    await maybeShowSkillUpdateNotice({ now, stderr });
    expect(stderr.write).not.toHaveBeenCalled();
    write(
      'skills/workflows/firecrawl-lead-research/references/brief.md',
      'Changed reference\n'
    );
    publish();
    const later = new Date(now.getTime() + 21 * 60 * 60 * 1000);
    await maybeShowSkillUpdateNotice({ now: later, stderr });
    expect(
      stripVTControlCharacters(String(stderr.write.mock.calls[0][0]))
    ).toContain('Run firecrawl setup workflows');
    expect(String(stderr.write.mock.calls[0][0])).not.toContain(
      'setup firecrawl-'
    );
    await handleSetupCommand('firecrawl-lead-research', {
      nativeSkills: true,
      quiet: true,
      skipAuthOffer: true,
    });
    expect(
      fs.existsSync(path.join(home, '.agents/skills/firecrawl-shop'))
    ).toBe(false);
    skill('workflows', 'firecrawl-new-workflow');
    publish();
    stderr.write.mockClear();
    await maybeShowSkillUpdateNotice({
      now: new Date(later.getTime() + 21 * 60 * 60 * 1000),
      stderr,
    });
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('firecrawl setup workflows')
    );
    expect(
      stripVTControlCharacters(String(stderr.write.mock.calls[0][0]))
    ).toContain('Run firecrawl setup workflows');
    stderr.write.mockClear();
    await maybeShowSkillUpdateNotice({
      now: new Date(later.getTime() + 42 * 60 * 60 * 1000),
      stderr,
    });
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('keeps new skills pending through cooldown and shows one command for mixed updates', async () => {
    skill('workflows', 'firecrawl-shop');
    publish();
    await install();
    fs.rmSync(path.join(home, '.agents/skills/firecrawl-shop'), {
      recursive: true,
    });
    write(
      'skills/workflows/firecrawl-lead-research/references/brief.md',
      'Changed reference\n'
    );
    publish();
    await maybeShowSkillUpdateNotice({ now, stderr });
    skill('workflows', 'firecrawl-new-workflow');
    publish();
    const cachePath = path.join(home, '.firecrawl/skill-update-check.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    cache.checkedAt = 0;
    fs.writeFileSync(cachePath, JSON.stringify(cache));
    stderr.write.mockClear();
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 1000),
      stderr,
    });
    expect(stderr.write).not.toHaveBeenCalled();
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 13 * 60 * 60 * 1000),
      stderr,
    });
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('firecrawl setup workflows')
    );
    const notice = stripVTControlCharacters(
      String(stderr.write.mock.calls[0][0])
    );
    expect(notice).toContain('Run firecrawl setup workflows');
    expect(notice.match(/Run firecrawl setup workflows/g)).toHaveLength(1);
    expect(notice).not.toContain('setup firecrawl-');
  });

  it('tells users of an earlier release about newly published skills once', async () => {
    await install();
    // Earlier releases recorded no baseline, so only the installed skills are known.
    fs.rmSync(path.join(home, '.firecrawl'), { recursive: true, force: true });
    skill('workflows', 'firecrawl-new-workflow');
    publish();
    await maybeShowSkillUpdateNotice({ now, stderr });
    const notice = stripVTControlCharacters(
      String(stderr.write.mock.calls[0][0])
    );
    expect(notice).toContain('Run firecrawl setup workflows');
    expect(notice).not.toContain('available to add');
    stderr.write.mockClear();
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 13 * 60 * 60 * 1000),
      stderr,
    });
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('records only the installed family, so other families still announce new skills', async () => {
    await installSkillsNative('firecrawl/skills', {
      family: 'core',
      agent: 'claude-code',
      quiet: true,
    });
    // An earlier release left no record; then a core skill is published.
    fs.rmSync(path.join(home, '.firecrawl'), { recursive: true, force: true });
    skill('core', 'firecrawl-new-core');
    publish();
    await install();
    await maybeShowSkillUpdateNotice({ now, stderr });
    const notice = stripVTControlCharacters(
      String(stderr.write.mock.calls[0][0])
    );
    expect(notice).toContain('Run firecrawl setup core');
    expect(notice).not.toContain('Run firecrawl setup workflows');
  });

  it.each(['single skill', 'whole repository'])(
    'remembers successful npx installs before a skill is removed: %s',
    async (mode) => {
      if (mode === 'single skill') {
        await installSkillsNative('firecrawl/skills', {
          skills: ['firecrawl-workflows'],
          agent: 'claude-code',
          quiet: true,
        });
        // An older install has not run a notification check yet.
        fs.rmSync(path.join(home, '.firecrawl'), {
          recursive: true,
          force: true,
        });
        mockNpxInstall(['firecrawl-lead-research']);
        await handleSetupCommand('firecrawl-lead-research', {
          skipAuthOffer: true,
        });
      } else {
        mockNpxInstall([
          'firecrawl',
          'firecrawl-workflows',
          'firecrawl-lead-research',
        ]);
        await installSkillsForAgent('codex', {}, ['firecrawl/skills']);
      }
      fs.rmSync(path.join(home, '.agents/skills/firecrawl-lead-research'), {
        recursive: true,
      });
      await maybeShowSkillUpdateNotice({ now, stderr });
      expect(stderr.write).not.toHaveBeenCalled();
    }
  );

  it('records npx installs under XDG state and discovers both installer locks', async () => {
    vi.stubEnv('XDG_STATE_HOME', path.join(home, 'state'));
    await installSkillsNative('firecrawl/skills', {
      skills: ['firecrawl'],
      agent: 'codex',
      quiet: true,
    });
    mockNpxInstall(['firecrawl-workflows', 'firecrawl-lead-research']);
    await installSkillsForAgent('codex', {}, ['firecrawl/skills']);
    const cache = JSON.parse(
      fs.readFileSync(
        path.join(home, '.firecrawl/skill-update-check.json'),
        'utf8'
      )
    );
    expect(cache.baseline).toContain('firecrawl-lead-research');
    fs.rmSync(path.join(home, '.agents/skills/firecrawl-lead-research'), {
      recursive: true,
    });
    await maybeShowSkillUpdateNotice({ now, stderr });
    expect(stderr.write).not.toHaveBeenCalled();
    write('skills/core/firecrawl/SKILL.md', 'Updated core skill');
    write(
      'skills/workflows/firecrawl-workflows/SKILL.md',
      'Updated workflow skill'
    );
    publish();
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 21 * 60 * 60 * 1000),
      stderr,
    });
    const notice = stripVTControlCharacters(
      String(stderr.write.mock.calls[0][0])
    );
    expect(notice).toContain('Run firecrawl setup core');
    expect(notice).toContain('Run firecrawl setup workflows');
  });

  it('keeps existing siblings quiet after a fresh npx umbrella install without warming the cache', async () => {
    expect(fs.existsSync(path.join(home, '.firecrawl'))).toBe(false);
    expect(requests).toBe(0);
    mockNpxInstall(['firecrawl-workflows']);
    await handleSetupCommand('firecrawl-workflows', { skipAuthOffer: true });
    expect(
      fs.existsSync(path.join(home, '.agents/skills/firecrawl-lead-research'))
    ).toBe(false);
    const cache = JSON.parse(
      fs.readFileSync(
        path.join(home, '.firecrawl/skill-update-check.json'),
        'utf8'
      )
    );
    expect(cache.baseline).toContain('firecrawl-lead-research');
    expect(cache.baseline).not.toContain('firecrawl');
    expect(cache.tree).toBeUndefined();
    await maybeShowSkillUpdateNotice({ now, stderr });
    expect(stderr.write).not.toHaveBeenCalled();
    skill('workflows', 'firecrawl-new-workflow');
    publish();
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 21 * 60 * 60 * 1000),
      stderr,
    });
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('firecrawl setup workflows')
    );
  });

  it('keeps previously seen workflows quiet after an umbrella-only install but announces later additions', async () => {
    await installSkillsNative('firecrawl/skills', {
      family: 'core',
      agent: 'claude-code',
      quiet: true,
    });
    await maybeShowSkillUpdateNotice({ now, stderr });
    mockNpxInstall(['firecrawl-workflows']);
    await handleSetupCommand('firecrawl-workflows', { skipAuthOffer: true });
    await maybeShowSkillUpdateNotice({ now, stderr });
    expect(stderr.write).not.toHaveBeenCalled();
    skill('workflows', 'firecrawl-new-workflow');
    publish();
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 21 * 60 * 60 * 1000),
      stderr,
    });
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('firecrawl setup workflows')
    );
  });

  it('records nothing when an install fails', async () => {
    await expect(
      installSkillsNative('firecrawl/skills', {
        skills: ['firecrawl-missing'],
        agent: 'claude-code',
        quiet: true,
      })
    ).rejects.toThrow('Skills not found');
    expect(
      fs.existsSync(path.join(home, '.firecrawl/skill-update-check.json'))
    ).toBe(false);
  });

  it('abandons a stalled catalog request without blocking the command', async () => {
    await install();
    stalled = true;
    const started = performance.now();
    await maybeShowSkillUpdateNotice({ now, stderr });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(requests).toBe(1);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it('does not offer a whole family for individually installed skills or inspect other publishers', async () => {
    await installSkillsNative('firecrawl/skills', {
      skills: ['firecrawl-lead-research'],
      agent: 'claude-code',
      quiet: true,
    });
    await maybeShowSkillUpdateNotice({ now, stderr });
    expect(stderr.write).not.toHaveBeenCalled();
    const lockPath = path.join(home, '.agents/.skill-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.skills['firecrawl-lead-research'].source = 'example/skills';
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    requests = 0;
    await maybeShowSkillUpdateNotice({
      now: new Date(now.getTime() + 21 * 60 * 60 * 1000),
      stderr,
    });
    expect(requests).toBe(0);
  });

  it('ignores truncated responses and malformed local state without failing commands', async () => {
    await install();
    response = { ...(response as object), truncated: true };
    await maybeShowSkillUpdateNotice({ now, stderr });
    expect(stderr.write).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(home, '.agents/.skill-lock.json'), '{broken');
    await expect(
      maybeShowSkillUpdateNotice({ now, stderr })
    ).resolves.toBeUndefined();
    expect(requests).toBe(1);
  });
});
