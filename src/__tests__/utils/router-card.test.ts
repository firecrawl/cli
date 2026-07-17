import {
  chmodSync,
  lstatSync,
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
import { afterEach, describe, expect, it } from 'vitest';
import {
  addRouterGuidanceToSkillDescription,
  installRouterCard,
  removeRouterCard,
  resolveRouterCardProject,
  resolveRouterCardContext,
  ROUTER_CARD,
  ROUTER_CARD_SHA256,
  ROUTER_SKILL_DESCRIPTION_PREFIX,
  ROUTER_SKILL_DESCRIPTION_PREFIX_SHA256,
} from '../../utils/router-card';

const projects: string[] = [];

function project(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-router-'));
  projects.push(directory);
  return directory;
}

afterEach(() => {
  while (projects.length > 0) {
    rmSync(projects.pop()!, { recursive: true, force: true });
  }
});

describe('router card', () => {
  it('keeps the exact EXP-028 agent-visible payloads', () => {
    expect(ROUTER_CARD_SHA256).toBe(
      'df867193a6fe011342fce14b770e497cf667ca755e396bb16bbb52c513627951'
    );
    expect(ROUTER_SKILL_DESCRIPTION_PREFIX_SHA256).toBe(
      '4d01a7080b1493975b0ea07a95db17c5a4f3b9030c0f5f237da9e634559c0cbd'
    );
    expect(ROUTER_CARD).toContain('firecrawl_search');
    expect(ROUTER_CARD).toContain('firecrawl_scrape');
    expect(ROUTER_CARD).not.toMatch(/api[_ -]?key|fc-[a-z0-9]|mcp\.firecrawl/i);
  });

  it('does not treat Codex App as the validated Codex CLI surface', () => {
    expect(() => resolveRouterCardContext('codex-app' as never)).toThrow(
      'Codex CLI'
    );
  });

  it.each([
    ['claude', 'CLAUDE.md'],
    ['codex', 'AGENTS.md'],
  ] as const)('writes %s project context atomically', (agent, relative) => {
    const root = project();
    const target = path.join(root, relative);
    writeFileSync(target, 'existing project rules\n');
    chmodSync(target, 0o600);

    const first = installRouterCard(agent, root);
    const second = installRouterCard(agent, root);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(first.sha256).toBe(ROUTER_CARD_SHA256);
    expect(readFileSync(target, 'utf8')).toBe(
      `existing project rules\n\n${ROUTER_CARD}\n`
    );
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual(
      []
    );
  });

  it('refreshes only its managed block and removes only that block', () => {
    const root = project();
    const target = path.join(root, 'AGENTS.md');
    writeFileSync(
      target,
      'before\n\n<!-- firecrawl-router-card:start -->\nold\n<!-- firecrawl-router-card:end -->\n\nafter\n'
    );

    installRouterCard('codex', root);
    expect(readFileSync(target, 'utf8')).toBe(
      `before\n\n${ROUTER_CARD}\n\nafter\n`
    );
    expect(removeRouterCard('codex', root).changed).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('before\n\nafter\n');
  });

  it.each([
    '<!-- firecrawl-router-card:start -->\nmissing end\n',
    '<!-- firecrawl-router-card:end -->\n',
    '<!-- firecrawl-router-card:start v1 -->\n<!-- firecrawl-router-card:end -->\n',
    `${ROUTER_CARD}\n${ROUTER_CARD}\n`,
  ])('rejects malformed ownership markers', (content) => {
    const root = project();
    const target = path.join(root, 'AGENTS.md');
    writeFileSync(target, content);

    expect(() => installRouterCard('codex', root)).toThrow(
      'malformed or duplicate'
    );
    expect(readFileSync(target, 'utf8')).toBe(content);
  });

  it('rejects symlink destinations without touching the referent', () => {
    const root = project();
    const referent = path.join(root, 'real.md');
    writeFileSync(referent, 'user content\n');
    symlinkSync(referent, path.join(root, 'AGENTS.md'));

    expect(() => installRouterCard('codex', root)).toThrow('symlink');
    expect(readFileSync(referent, 'utf8')).toBe('user content\n');
  });

  it('resolves an implicit nested cwd to its Git worktree', () => {
    const root = project();
    const nested = path.join(root, 'packages', 'app');
    mkdirSync(path.join(root, '.git'));
    mkdirSync(nested, { recursive: true });
    expect(resolveRouterCardProject(undefined, nested)).toBe(root);
  });

  it('adds the exact prefix without replacing the original description', () => {
    const source =
      '---\nname: firecrawl-test\ndescription: Original.\n---\nBody\n';
    const routed = addRouterGuidanceToSkillDescription(source);
    expect(routed).toContain(ROUTER_SKILL_DESCRIPTION_PREFIX);
    expect(routed).toContain('Original.');
    expect(addRouterGuidanceToSkillDescription(routed)).toBe(routed);
  });
});
