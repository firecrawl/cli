import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const SKILLS_DIR = path.resolve(__dirname, '../../skills');
const MAX_DESCRIPTION_LENGTH = 1024;

describe('skill frontmatter', () => {
  it('keeps every description within the Copilot CLI limit', () => {
    const skillDirectories = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const skillDirectory of skillDirectories) {
      const skillPath = path.join(SKILLS_DIR, skillDirectory, 'SKILL.md');
      const content = readFileSync(skillPath, 'utf8');
      const frontmatterMatch = content.match(
        /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
      );

      expect(
        frontmatterMatch,
        `${skillPath} must contain YAML frontmatter`
      ).not.toBeNull();

      const frontmatter = parse(frontmatterMatch![1]) as Record<
        string,
        unknown
      >;
      expect(
        typeof frontmatter.description,
        `${skillPath} must have a description`
      ).toBe('string');
      expect(
        (frontmatter.description as string).length,
        `${skillPath} description exceeds ${MAX_DESCRIPTION_LENGTH} characters`
      ).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    }
  });
});
