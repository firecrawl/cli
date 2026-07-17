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

function canonicalSkill(name: string, description = 'Original.'): string {
  const directory = path.join(home, '.agents', 'skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`
  );
  writeFileSync(path.join(directory, 'reference.txt'), `${name}\n`);
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
        complete: true,
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
    rmSync(path.join(home, '.agents', 'skills', 'firecrawl-beta'), {
      recursive: true,
    });
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
    expect(removed.complete).toBe(false);
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

    expect(removed.complete).toBe(true);
    expect(removed.skills.removed).toHaveLength(2);
    expect(removed.preference).toMatchObject({ enabled: false, changed: true });
    expect(readFileSync(removed.preference.path, 'utf8')).toContain(
      '"enabled": false'
    );
    expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe('');

    const disabled = install();
    expect(disabled.status).toBe('disabled');
    expect(disabled.complete).toBe(false);
    expect(existsSync(path.join(project, '.agents', 'skills'))).toBe(true);
    expect(readdirSync(path.join(project, '.agents', 'skills'))).toEqual([]);

    const enabled = install('codex', true);
    expect(enabled.status).toBe('installed');
    expect(enabled.preference).toMatchObject({ enabled: true, changed: true });
    expect(existsSync(enabled.preference.path)).toBe(false);
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
