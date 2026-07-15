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
import { removeInstalledRouterGuidance } from '../../commands/skills-native';
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

describe('installed router guidance removal', () => {
  it('restores canonical skill descriptions once across agent symlinks', () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-router-home-'));
    vi.stubEnv('HOME', home);
    const canonical = path.join(home, '.agents', 'skills', 'firecrawl-example');
    const codex = path.join(home, '.codex', 'skills');
    mkdirSync(canonical, { recursive: true });
    mkdirSync(codex, { recursive: true });
    const original = `---\nname: firecrawl-example\ndescription: Original.\n---\nBody\n`;
    writeFileSync(
      path.join(canonical, 'SKILL.md'),
      addRouterGuidanceToSkillDescription(original)
    );
    const lockPath = path.join(home, '.agents', '.skill-lock.json');
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 3,
        skills: {
          'firecrawl-example': {
            source: 'firecrawl/cli',
            sourceType: 'github',
            sourceUrl: 'https://github.com/firecrawl/cli.git',
            skillPath: 'skills/firecrawl-example/SKILL.md',
            skillFolderHash: 'before-removal',
            installedAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }) + '\n'
    );
    symlinkSync(
      path.relative(codex, canonical),
      path.join(codex, 'firecrawl-example')
    );

    expect(removeInstalledRouterGuidance('codex')).toBe(1);
    const restored = readFileSync(path.join(canonical, 'SKILL.md'), 'utf8');
    expect(restored).not.toContain(ROUTER_SKILL_DESCRIPTION_PREFIX);
    expect(restored).toContain('description: "Original."');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(lock.skills['firecrawl-example'].skillFolderHash).not.toBe(
      'before-removal'
    );
    expect(lock.skills['firecrawl-example'].installedAt).toBe(
      '2026-01-01T00:00:00.000Z'
    );
    expect(removeInstalledRouterGuidance('codex')).toBe(0);
  });
});
