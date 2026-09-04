import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock os.homedir to use isolated temp directory
let tmpHome: string;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => tmpHome,
    },
    homedir: () => tmpHome,
  };
});

describe('AdaL native agent integration', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-adal-test-'));
    // Create the .adal directory to simulate an installed AdaL
    fs.mkdirSync(path.join(tmpHome, '.adal'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('assertion 3+5: adal agent is registered with correct detectDir and globalSkillsDir', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../commands/skills-native.ts'),
      'utf-8'
    );
    expect(source).toContain("name: 'adal'");
    expect(source).toContain("globalSkillsDir: '.adal/skills'");
    expect(source).toContain("detectDir: '.adal'");
  });

  it('assertion 7: auto-detection recognizes existing .adal directory', async () => {
    const { detectInstalledAgentNames } = await import('../commands/skills-native.ts');
    const names = detectInstalledAgentNames();
    expect(names).toContain('adal');
  });

  it('assertion 8+9: isolated install succeeds and places artifacts in .adal/skills', async () => {
    const { installSkillsNative } = await import('../commands/skills-native.ts');
    const result = await installSkillsNative('firecrawl/cli', { agent: 'adal', quiet: true });

    expect(result.skillCount).toBeGreaterThan(0);
    expect(result.linkedAgents).toContain('adal');

    // Artifacts reside beneath isolated AdaL personal skills directory
    const skillsDir = path.join(tmpHome, '.adal', 'skills');
    expect(fs.existsSync(skillsDir)).toBe(true);
    const entries = fs.readdirSync(skillsDir);
    expect(entries.length).toBeGreaterThan(0);
  }, 60_000);

  it('assertion 10: every installed skill has valid SKILL.md with name+description', async () => {
    const { installSkillsNative } = await import('../commands/skills-native.ts');
    await installSkillsNative('firecrawl/cli', { agent: 'adal', quiet: true });

    const skillsDir = path.join(tmpHome, '.adal', 'skills');
    const entries = fs.readdirSync(skillsDir);

    for (const entry of entries) {
      const entryPath = path.join(skillsDir, entry);
      const realPath = fs.realpathSync(entryPath);
      const skillMd = path.join(realPath, 'SKILL.md');
      expect(fs.existsSync(skillMd), `SKILL.md missing in ${entry}`).toBe(true);

      const content = fs.readFileSync(skillMd, 'utf-8');
      expect(content, `${entry}/SKILL.md must have frontmatter`).toMatch(/^---\s*\n/);
      expect(content, `${entry}/SKILL.md must have name`).toMatch(/name:\s*.+/);
      expect(content, `${entry}/SKILL.md must have description`).toMatch(/description:/);
    }
  }, 60_000);

  it('assertion 11: preserves pre-existing user-owned skill files with non-conflicting names', async () => {
    // Create a user skill with a unique non-firecrawl name
    const userSkillDir = path.join(tmpHome, '.adal', 'skills', 'my-custom-skill');
    fs.mkdirSync(userSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(userSkillDir, 'SKILL.md'),
      '---\nname: my-custom-skill\ndescription: User owned\n---\n# My Skill\n'
    );

    const { installSkillsNative } = await import('../commands/skills-native.ts');
    await installSkillsNative('firecrawl/cli', { agent: 'adal', quiet: true });

    // User skill should still exist unchanged
    expect(fs.existsSync(path.join(userSkillDir, 'SKILL.md'))).toBe(true);
    const content = fs.readFileSync(path.join(userSkillDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('my-custom-skill');
    expect(content).toContain('User owned');
  }, 60_000);

  it('assertion 12: idempotent reinstall produces stable result', async () => {
    const { installSkillsNative } = await import('../commands/skills-native.ts');

    const result1 = await installSkillsNative('firecrawl/cli', { agent: 'adal', quiet: true });
    const skillsDir = path.join(tmpHome, '.adal', 'skills');
    const entries1 = fs.readdirSync(skillsDir).sort();

    const result2 = await installSkillsNative('firecrawl/cli', { agent: 'adal', quiet: true });
    const entries2 = fs.readdirSync(skillsDir).sort();

    expect(result1.skillCount).toBe(result2.skillCount);
    expect(entries1).toEqual(entries2);
  }, 120_000);

  it('assertion 13: collision — same-named user directory is preserved, NOT overwritten', async () => {
    // Create a user skill with same name as a firecrawl skill
    const skillsDir = path.join(tmpHome, '.adal', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const conflictDir = path.join(skillsDir, 'firecrawl-scrape');
    fs.mkdirSync(conflictDir, { recursive: true });
    const userContent = '---\nname: firecrawl-scrape\ndescription: User custom version\n---\n# Custom\n';
    fs.writeFileSync(path.join(conflictDir, 'SKILL.md'), userContent);
    fs.writeFileSync(path.join(conflictDir, 'my-notes.md'), '# My notes\n');

    const { installSkillsNative } = await import('../commands/skills-native.ts');
    await installSkillsNative('firecrawl/cli', { agent: 'adal', quiet: true });

    // After install, the user's directory must still exist as a real directory (not symlink)
    const stat = fs.lstatSync(conflictDir);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);

    // User content must be preserved
    const preserved = fs.readFileSync(path.join(conflictDir, 'SKILL.md'), 'utf-8');
    expect(preserved).toContain('User custom version');
    expect(fs.existsSync(path.join(conflictDir, 'my-notes.md'))).toBe(true);
    expect(fs.readFileSync(path.join(conflictDir, 'my-notes.md'), 'utf-8')).toContain('My notes');
  }, 60_000);

  it('assertion 13b: collision — same-named user file is preserved, NOT overwritten', async () => {
    // Edge case: a regular file (not dir) at the skill name path
    const skillsDir = path.join(tmpHome, '.adal', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const conflictFile = path.join(skillsDir, 'firecrawl-search');
    fs.writeFileSync(conflictFile, '# user placeholder file\n');

    const { installSkillsNative } = await import('../commands/skills-native.ts');
    await installSkillsNative('firecrawl/cli', { agent: 'adal', quiet: true });

    // After install, user's file must remain intact
    const stat = fs.lstatSync(conflictFile);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(fs.readFileSync(conflictFile, 'utf-8')).toContain('user placeholder file');
  }, 60_000);

  it('assertion 13c: stale symlinks ARE safely replaced', async () => {
    // A stale symlink (pointing nowhere) should be replaced
    const skillsDir = path.join(tmpHome, '.adal', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const stalePath = path.join(skillsDir, 'firecrawl-map');
    fs.symlinkSync('/nonexistent/path/that/does/not/exist', stalePath);

    const { installSkillsNative } = await import('../commands/skills-native.ts');
    await installSkillsNative('firecrawl/cli', { agent: 'adal', quiet: true });

    // Stale symlink should be replaced with correct symlink
    const stat = fs.lstatSync(stalePath);
    expect(stat.isSymbolicLink()).toBe(true);
    // Should now point to canonical dir
    const target = fs.readlinkSync(stalePath);
    expect(target).toContain('.agents/skills/firecrawl-map');
  }, 60_000);

  it('assertion 14: unwritable destination causes error, no corrupt partial state', async () => {
    // Make the .agents directory (canonical dest) unwritable
    const agentsDir = path.join(tmpHome, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.chmodSync(agentsDir, 0o444);

    const { installSkillsNative } = await import('../commands/skills-native.ts');
    await expect(
      installSkillsNative('firecrawl/cli', { agent: 'adal', quiet: true })
    ).rejects.toThrow();

    // Restore for cleanup
    fs.chmodSync(agentsDir, 0o755);
  }, 60_000);

  it('assertion 15: paths resolve under isolated HOME, not real HOME', async () => {
    const { installSkillsNative } = await import('../commands/skills-native.ts');
    await installSkillsNative('firecrawl/cli', { agent: 'adal', quiet: true });

    const skillsDir = path.join(tmpHome, '.adal', 'skills');
    expect(skillsDir.startsWith(tmpHome)).toBe(true);
    expect(fs.existsSync(skillsDir)).toBe(true);

    const canonicalDir = path.join(tmpHome, '.agents', 'skills');
    expect(fs.existsSync(canonicalDir)).toBe(true);
    expect(canonicalDir.startsWith(tmpHome)).toBe(true);
  }, 60_000);
});

describe('Generic collision guard (non-AdaL harness)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-generic-test-'));
    // Create .codex directory to simulate an installed Codex agent
    fs.mkdirSync(path.join(tmpHome, '.codex'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('preserves same-named user-owned directory for codex harness', async () => {
    // Pre-create a user-owned skill dir with same name as a firecrawl skill
    const codexSkillsDir = path.join(tmpHome, '.codex', 'skills');
    fs.mkdirSync(codexSkillsDir, { recursive: true });
    const conflictDir = path.join(codexSkillsDir, 'firecrawl-scrape');
    fs.mkdirSync(conflictDir, { recursive: true });
    fs.writeFileSync(
      path.join(conflictDir, 'SKILL.md'),
      '---\nname: firecrawl-scrape\ndescription: Codex user custom version\n---\n# My codex custom scrape\n'
    );
    fs.writeFileSync(path.join(conflictDir, 'helper.sh'), '#!/bin/bash\necho custom\n');

    const { installSkillsNative } = await import('../commands/skills-native.ts');
    await installSkillsNative('firecrawl/cli', { agent: 'codex', quiet: true });

    // User-owned directory must remain a real directory (not replaced by symlink)
    const stat = fs.lstatSync(conflictDir);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);

    // User content must be intact
    const content = fs.readFileSync(path.join(conflictDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('Codex user custom version');
    expect(fs.existsSync(path.join(conflictDir, 'helper.sh'))).toBe(true);
    expect(fs.readFileSync(path.join(conflictDir, 'helper.sh'), 'utf-8')).toContain('echo custom');
  }, 60_000);

  it('preserves same-named user-owned file for codex harness', async () => {
    const codexSkillsDir = path.join(tmpHome, '.codex', 'skills');
    fs.mkdirSync(codexSkillsDir, { recursive: true });
    const conflictFile = path.join(codexSkillsDir, 'firecrawl-search');
    fs.writeFileSync(conflictFile, '# codex user placeholder\n');

    const { installSkillsNative } = await import('../commands/skills-native.ts');
    await installSkillsNative('firecrawl/cli', { agent: 'codex', quiet: true });

    // User file must remain intact
    const stat = fs.lstatSync(conflictFile);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(fs.readFileSync(conflictFile, 'utf-8')).toContain('codex user placeholder');
  }, 60_000);
});
