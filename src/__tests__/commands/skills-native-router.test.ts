import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installProjectRouterGuidance,
  removeInstalledRouterGuidance,
} from '../../commands/skills-native';
import {
  addRouterGuidanceToSkillDescription,
  ROUTER_SKILL_DESCRIPTION_PREFIX,
} from '../../utils/router-card';

let home: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe('project-scoped router skill guidance', () => {
  it('creates a routed project copy without changing canonical global skills', () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-router-home-'));
    vi.stubEnv('HOME', home);
    const canonical = path.join(home, '.agents', 'skills', 'firecrawl-example');
    const project = path.join(home, 'project');
    mkdirSync(canonical, { recursive: true });
    const original = `---\nname: firecrawl-example\ndescription: Original.\n---\nBody\n`;
    writeFileSync(path.join(canonical, 'SKILL.md'), original);

    expect(installProjectRouterGuidance('codex', project)).toBe(1);
    expect(readFileSync(path.join(canonical, 'SKILL.md'), 'utf8')).toBe(
      original
    );
    const projectSkill = path.join(
      project,
      '.agents',
      'skills',
      'firecrawl-example',
      'SKILL.md'
    );
    expect(readFileSync(projectSkill, 'utf8')).toContain(
      ROUTER_SKILL_DESCRIPTION_PREFIX
    );
    expect(installProjectRouterGuidance('codex', project)).toBe(0);

    expect(removeInstalledRouterGuidance('codex', project)).toBe(1);
    expect(() => readFileSync(projectSkill, 'utf8')).toThrow();
    expect(readFileSync(path.join(canonical, 'SKILL.md'), 'utf8')).toBe(
      original
    );
    expect(removeInstalledRouterGuidance('codex', project)).toBe(0);
  });

  it('only removes the exact prefix from an existing project-owned skill', () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-router-home-'));
    vi.stubEnv('HOME', home);
    const projectSkill = path.join(
      home,
      'project',
      '.claude',
      'skills',
      'firecrawl-example',
      'SKILL.md'
    );
    mkdirSync(path.dirname(projectSkill), { recursive: true });
    const original = `---\nname: firecrawl-example\ndescription: User project skill.\n---\nBody\n`;
    writeFileSync(
      projectSkill,
      addRouterGuidanceToSkillDescription(original),
      'utf8'
    );

    expect(
      removeInstalledRouterGuidance('claude-code', path.join(home, 'project'))
    ).toBe(1);
    expect(readFileSync(projectSkill, 'utf8')).toContain(
      'description: "User project skill."'
    );
  });
});
