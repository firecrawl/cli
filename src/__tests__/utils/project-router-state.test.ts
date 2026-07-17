import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFullProjectRouterState,
  removeFullProjectRouterState,
} from '../../utils/project-router-state';
import {
  ROUTER_CARD_SHA256,
  ROUTER_SKILL_DESCRIPTION_PREFIX,
  ROUTER_SKILL_DESCRIPTION_PREFIX_SHA256,
} from '../../utils/router-card';

let home: string;
let project: string;
let lockSkills: Record<string, Record<string, string>>;

function writeSkillLock(): void {
  const lockPath = path.join(home, '.agents', '.skill-lock.json');
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(
    lockPath,
    `${JSON.stringify({ version: 3, skills: lockSkills }, null, 2)}\n`
  );
}

function skillFolderHash(directory: string): string {
  const hash = createHash('sha1');
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name)
    )) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else {
        hash.update(entry.name);
        hash.update(readFileSync(absolute));
      }
    }
  };
  walk(directory);
  return hash.digest('hex');
}

function refreshLockedSkillHash(name: string): void {
  lockSkills[name].skillFolderHash = skillFolderHash(
    path.join(home, '.agents', 'skills', name)
  );
  writeSkillLock();
}

function canonicalSkill(
  name: string,
  description = 'Original.',
  source = 'firecrawl/cli',
  sourceUrl = `https://github.com/${source}.git`
): string {
  const directory = path.join(home, '.agents', 'skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`
  );
  writeFileSync(path.join(directory, 'reference.txt'), `${name}\n`);
  lockSkills[name] = {
    source,
    sourceUrl,
    skillPath: `skills/${name}/SKILL.md`,
    skillFolderHash: skillFolderHash(directory),
  };
  writeSkillLock();
  return directory;
}

function install(agent: 'claude' | 'codex' = 'codex', forceEnable = false) {
  return installFullProjectRouterState({
    agent,
    project,
    authenticated: true,
    mcpInstalled: true,
    skillsInstalled: true,
    forceEnable,
  });
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-router-home-'));
  project = path.join(home, 'project');
  mkdirSync(project);
  vi.stubEnv('HOME', home);
  lockSkills = {};
  canonicalSkill('firecrawl-alpha');
  canonicalSkill('firecrawl-beta');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('full project router state', () => {
  it.each([
    ['claude', 'CLAUDE.md', path.join('.claude', 'skills')],
    ['codex', 'AGENTS.md', path.join('.agents', 'skills')],
  ] as const)(
    'materializes an exact, digest-backed %s state and returns a receipt',
    (agent, cardName, skillRoot) => {
      const first = install(agent);
      const second = install(agent);

      expect(first).toMatchObject({
        operation: 'install',
        status: 'installed',
        agent,
        project,
        operationComplete: true,
        artifactsConfigured: true,
        nativeDiscovery: { status: 'pending', verified: false },
        card: { sha256: ROUTER_CARD_SHA256, changed: true },
        skills: { sourceCount: 2, changed: true },
        preference: { enabled: true },
      });
      expect(first.skills.installed).toHaveLength(2);
      expect(second.status).toBe('current');
      expect(second.skills.current).toHaveLength(2);
      expect(second.skills.changed).toBe(false);
      expect(readFileSync(path.join(project, cardName), 'utf8')).toContain(
        'Firecrawl web routing'
      );

      for (const skill of first.skills.installed) {
        expect(skill.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(skill.routedSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(skill.sourceSha256).not.toBe(skill.routedSha256);
        expect(skill.routerPrefixSha256).toBe(
          ROUTER_SKILL_DESCRIPTION_PREFIX_SHA256
        );
        expect(skill.provenance).toEqual(
          expect.objectContaining({
            source: 'firecrawl/cli',
            sourceUrl: 'https://github.com/firecrawl/cli.git',
            skillPath: expect.stringContaining(skill.skillName),
          })
        );
        expect(
          readFileSync(path.join(skill.path, 'SKILL.md'), 'utf8')
        ).toContain(ROUTER_SKILL_DESCRIPTION_PREFIX);
        expect(
          JSON.parse(
            readFileSync(
              path.join(skill.path, '.firecrawl-router-skill.json'),
              'utf8'
            )
          )
        ).toMatchObject({
          skillName: path.basename(skill.path),
          sourceSha256: skill.sourceSha256,
          routedSha256: skill.routedSha256,
          routerPrefixSha256: ROUTER_SKILL_DESCRIPTION_PREFIX_SHA256,
          provenance: skill.provenance,
        });
      }
      expect(
        readdirSync(path.join(project, skillRoot)).filter(
          (name) => name.endsWith('.tmp') || name.endsWith('.backup')
        )
      ).toEqual([]);
    }
  );

  it('refreshes changed sources and prunes only obsolete managed skills', () => {
    install();
    writeFileSync(
      path.join(home, '.agents', 'skills', 'firecrawl-alpha', 'reference.txt'),
      'updated\n'
    );
    refreshLockedSkillHash('firecrawl-alpha');
    rmSync(path.join(home, '.agents', 'skills', 'firecrawl-beta'), {
      recursive: true,
    });
    delete lockSkills['firecrawl-beta'];
    writeSkillLock();
    const userSkill = path.join(project, '.agents', 'skills', 'firecrawl-user');
    mkdirSync(userSkill);
    writeFileSync(path.join(userSkill, 'SKILL.md'), 'user owned\n');

    const receipt = install();

    expect(receipt.skills.refreshed.map((item) => item.skillName)).toEqual([
      'firecrawl-alpha',
    ]);
    expect(receipt.skills.pruned.map((item) => item.skillName)).toEqual([
      'firecrawl-beta',
    ]);
    expect(readFileSync(path.join(userSkill, 'SKILL.md'), 'utf8')).toBe(
      'user owned\n'
    );
  });

  it('sources skills only from lock entries with allowed repo provenance', () => {
    canonicalSkill('unprefixed-approved', 'Approved.', 'firecrawl/skills');
    canonicalSkill(
      'firecrawl-untrusted',
      'Untrusted.',
      'someone/else',
      'https://github.com/someone/else.git'
    );
    canonicalSkill(
      'firecrawl-mismatched-url',
      'Mismatch.',
      'firecrawl/cli',
      'https://github.com/someone/else.git'
    );

    const receipt = install();

    expect(receipt.skills.installed.map((item) => item.skillName)).toContain(
      'unprefixed-approved'
    );
    expect(
      receipt.skills.installed.map((item) => item.skillName)
    ).not.toContain('firecrawl-untrusted');
    expect(
      receipt.skills.installed.map((item) => item.skillName)
    ).not.toContain('firecrawl-mismatched-url');
    expect(
      existsSync(path.join(project, '.agents', 'skills', 'firecrawl-untrusted'))
    ).toBe(false);
  });

  it('rejects a missing or malformed provenance lock before card mutation', () => {
    rmSync(path.join(home, '.agents', '.skill-lock.json'));
    expect(() => install()).toThrow('provenance lock is missing');
    expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(false);

    writeFileSync(path.join(home, '.agents', '.skill-lock.json'), '{bad');
    expect(() => install()).toThrow('provenance lock is malformed');
    expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(false);
  });

  it('rejects canonical skill content that no longer matches its lock hash', () => {
    writeFileSync(
      path.join(home, '.agents', 'skills', 'firecrawl-alpha', 'reference.txt'),
      'tampered\n'
    );

    expect(() => install()).toThrow('does not match its provenance hash');
    expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(false);
  });

  it('rejects user-owned collisions before writing a card', () => {
    const collision = path.join(
      project,
      '.agents',
      'skills',
      'firecrawl-alpha'
    );
    mkdirSync(collision, { recursive: true });
    writeFileSync(path.join(collision, 'SKILL.md'), 'user owned\n');

    expect(() => install()).toThrow('user-owned');
    expect(readFileSync(path.join(collision, 'SKILL.md'), 'utf8')).toBe(
      'user owned\n'
    );
    expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(false);
  });

  it('preflights card ownership before writing managed skills', () => {
    writeFileSync(
      path.join(project, 'AGENTS.md'),
      '<!-- firecrawl-router-card:start -->\nmissing end\n'
    );

    expect(() => install()).toThrow('malformed or duplicate');
    expect(existsSync(path.join(project, '.agents', 'skills'))).toBe(false);
  });

  it('rejects project skill symlinks without touching the referent', () => {
    const referent = path.join(home, 'user-skill');
    mkdirSync(referent);
    writeFileSync(path.join(referent, 'SKILL.md'), 'user owned\n');
    const skillRoot = path.join(project, '.agents', 'skills');
    mkdirSync(skillRoot, { recursive: true });
    symlinkSync(referent, path.join(skillRoot, 'firecrawl-alpha'));

    expect(() => install()).toThrow('symlink');
    expect(readFileSync(path.join(referent, 'SKILL.md'), 'utf8')).toBe(
      'user owned\n'
    );
  });

  it('rolls back card and skill mutations when a managed replacement fails', () => {
    const first = install();
    const managed = first.skills.installed.find(
      (item) => item.skillName === 'firecrawl-alpha'
    )!;
    const originalSkill = readFileSync(
      path.join(managed.path, 'reference.txt'),
      'utf8'
    );
    writeFileSync(path.join(project, 'AGENTS.md'), 'user context\n');
    writeFileSync(
      path.join(home, '.agents', 'skills', 'firecrawl-alpha', 'reference.txt'),
      'updated\n'
    );
    refreshLockedSkillHash('firecrawl-alpha');

    const originalRename = fs.renameSync.bind(fs);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('.tmp') && String(to) === managed.path) {
        throw new Error('simulated managed replacement failure');
      }
      return originalRename(from, to);
    });

    expect(() => install()).toThrow('simulated managed replacement failure');
    rename.mockRestore();
    expect(readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe(
      'user context\n'
    );
    expect(readFileSync(path.join(managed.path, 'reference.txt'), 'utf8')).toBe(
      originalSkill
    );
    expect(
      readdirSync(path.dirname(managed.path)).filter(
        (name) => name.endsWith('.tmp') || name.endsWith('.backup')
      )
    ).toEqual([]);
  });

  it('rejects symlinks inside canonical source skills', () => {
    symlinkSync(
      path.join(home, '.agents', 'skills', 'firecrawl-alpha', 'reference.txt'),
      path.join(home, '.agents', 'skills', 'firecrawl-alpha', 'link.txt')
    );
    expect(() => install()).toThrow('source contains a symlink');
    expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(false);
  });

  it('never refreshes or deletes a modified managed skill while still opting out', () => {
    const receipt = install();
    const managed = receipt.skills.installed[0].path;
    writeFileSync(path.join(managed, 'user-note.txt'), 'keep me\n');

    expect(() => install()).toThrow('modified router skill');
    const removed = removeFullProjectRouterState('codex', project);
    expect(removed.status).toBe('removed-with-preserved-content');
    expect(removed.operationComplete).toBe(false);
    expect(removed.artifactsConfigured).toBe(false);
    expect(removed.skills.preserved).toEqual([
      expect.objectContaining({
        path: managed,
        skillName: path.basename(managed),
        reason: expect.stringContaining('modified router skill'),
      }),
    ]);
    expect(readFileSync(path.join(managed, 'user-note.txt'), 'utf8')).toBe(
      'keep me\n'
    );
    expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe('');
    expect(readFileSync(removed.preference.path, 'utf8')).toContain(
      '"enabled": false'
    );
  });

  it('preserves a symlinked managed skill while still removing the card', () => {
    const receipt = install();
    const managed = receipt.skills.installed[0].path;
    const referent = path.join(home, 'preserved-router-skill');
    rmSync(managed, { recursive: true });
    mkdirSync(referent);
    writeFileSync(path.join(referent, 'SKILL.md'), 'user content\n');
    writeFileSync(
      path.join(referent, '.firecrawl-router-skill.json'),
      JSON.stringify(receipt.skills.installed[0])
    );
    symlinkSync(referent, managed);

    const removed = removeFullProjectRouterState('codex', project);

    expect(removed.status).toBe('removed-with-preserved-content');
    expect(removed.skills.preserved).toEqual([
      expect.objectContaining({
        path: managed,
        reason: expect.stringContaining('symlink'),
      }),
    ]);
    expect(readFileSync(path.join(referent, 'SKILL.md'), 'utf8')).toBe(
      'user content\n'
    );
    expect(readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe('');
  });

  it('persists removal as an opt-out until explicitly re-enabled', () => {
    install();
    const removed = removeFullProjectRouterState('codex', project);

    expect(removed.operationComplete).toBe(true);
    expect(removed.skills.removed).toHaveLength(2);
    expect(removed.preference).toMatchObject({ enabled: false, changed: true });
    expect(readFileSync(removed.preference.path, 'utf8')).toContain(
      '"enabled": false'
    );
    expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe('');

    const disabled = install();
    expect(disabled.status).toBe('disabled');
    expect(disabled.operationComplete).toBe(true);
    expect(disabled.artifactsConfigured).toBe(false);
    expect(existsSync(path.join(project, '.agents', 'skills'))).toBe(true);
    expect(readdirSync(path.join(project, '.agents', 'skills'))).toEqual([]);

    const enabled = install('codex', true);
    expect(enabled.status).toBe('installed');
    expect(enabled.preference).toMatchObject({ enabled: true, changed: true });
    expect(existsSync(enabled.preference.path)).toBe(false);
  });

  it('persists opt-out while preserving malformed router-card content', () => {
    const malformed =
      'user context\n<!-- firecrawl-router-card:start -->\nmissing end\n';
    writeFileSync(path.join(project, 'AGENTS.md'), malformed);

    const removed = removeFullProjectRouterState('codex', project);

    expect(removed.status).toBe('removed-with-preserved-content');
    expect(removed.operationComplete).toBe(false);
    expect(removed.preservedCard).toEqual({
      path: path.join(project, 'AGENTS.md'),
      reason: expect.stringContaining('malformed or duplicate'),
    });
    expect(readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe(
      malformed
    );
    expect(readFileSync(removed.preference.path, 'utf8')).toContain(
      '"enabled": false'
    );
  });

  it('fails closed unless all accepted-state prerequisites are true', () => {
    expect(() =>
      installFullProjectRouterState({
        agent: 'codex',
        project,
        authenticated: true,
        mcpInstalled: false,
        skillsInstalled: true,
      })
    ).toThrow('requires authenticated MCP and skills setup');
    expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(false);
  });
});
