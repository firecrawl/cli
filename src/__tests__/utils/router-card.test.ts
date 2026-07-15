import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
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
  removeRouterGuidanceFromSkillDescription,
  resolveRouterCardProject,
  resolveRouterCardContext,
  ROUTER_CARD,
  ROUTER_CARD_SHA256,
  ROUTER_CARD_VERSION,
  ROUTER_SKILL_DESCRIPTION_PREFIX,
  routerCardPath,
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

describe('router card delivery', () => {
  it.each([
    ['claude', 'CLAUDE.md'],
    ['claude-code', 'CLAUDE.md'],
    ['codex', 'AGENTS.md'],
  ])('writes %s guidance to its native project context', (agent, relative) => {
    const root = project();
    const result = installRouterCard(agent, root);

    expect(result).toEqual({
      path: path.join(root, relative),
      changed: true,
      version: ROUTER_CARD_VERSION,
      sha256: ROUTER_CARD_SHA256,
    });
    const content = readFileSync(result.path, 'utf8');
    expect(content).toBe(`${ROUTER_CARD}\n`);
  });

  it('preserves unrelated content and updates the managed block in place', () => {
    const root = project();
    const target = path.join(root, 'AGENTS.md');
    writeFileSync(
      target,
      `before\n\n<!-- firecrawl-router-card:start -->\nold\n<!-- firecrawl-router-card:end -->\n\nafter\n`
    );

    installRouterCard('codex', root);

    expect(readFileSync(target, 'utf8')).toBe(
      `before\n\n${ROUTER_CARD}\n\nafter\n`
    );
  });

  it('is byte-for-byte idempotent once current', () => {
    const root = project();
    const first = installRouterCard('codex', root);
    const before = readFileSync(first.path, 'utf8');

    const second = installRouterCard('codex', root);

    expect(second.changed).toBe(false);
    expect(readFileSync(first.path, 'utf8')).toBe(before);
  });

  it('preserves permissions while atomically replacing an existing file', () => {
    const root = project();
    const target = path.join(root, 'AGENTS.md');
    writeFileSync(target, 'project rules\n');
    chmodSync(target, 0o600);

    installRouterCard('codex', root);

    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual(
      []
    );
  });

  it.each([
    '<!-- firecrawl-router-card:start -->\nmissing end\n',
    '<!-- firecrawl-router-card:end -->\n',
    '<!-- firecrawl-router-card:start v1 -->\n<!-- firecrawl-router-card:end -->\n',
    `${ROUTER_CARD}\n${ROUTER_CARD}\n`,
    `<!-- firecrawl-router-card:end -->\n${ROUTER_CARD}\n`,
  ])('refuses malformed or duplicate marker state', (content) => {
    const root = project();
    const target = path.join(root, 'AGENTS.md');
    writeFileSync(target, content);

    expect(() => installRouterCard('codex', root)).toThrow(
      'malformed or duplicate'
    );
    expect(readFileSync(target, 'utf8')).toBe(content);
  });

  it('refuses a symlink destination without changing its referent', () => {
    const root = project();
    const referent = path.join(root, 'real.md');
    writeFileSync(referent, 'do not touch\n');
    symlinkSync(referent, path.join(root, 'AGENTS.md'));

    expect(() => installRouterCard('codex', root)).toThrow('symlink');
    expect(readFileSync(referent, 'utf8')).toBe('do not touch\n');
  });

  it('refuses a broken symlink destination', () => {
    const root = project();
    symlinkSync(path.join(root, 'missing.md'), path.join(root, 'AGENTS.md'));

    expect(() => installRouterCard('codex', root)).toThrow('symlink');
  });

  it('contains routing only and no credentials or hosted MCP URL', () => {
    expect(ROUTER_CARD).toContain('firecrawl_search');
    expect(ROUTER_CARD).toContain('firecrawl_scrape');
    expect(ROUTER_CARD).toContain(
      'Respect explicit requests to stay offline, avoid web lookup, or use another named tool.'
    );
    expect(ROUTER_CARD).not.toMatch(/api[_ -]?key|fc-[a-z0-9]|mcp\.firecrawl/i);
  });

  it('rejects unknown agents and missing project directories', () => {
    expect(() => resolveRouterCardContext('unknown')).toThrow('not supported');
    expect(() =>
      installRouterCard('codex', path.join(project(), 'missing'))
    ).toThrow('not a directory');
  });

  it('resolves paths without writing files', () => {
    const root = project();
    expect(routerCardPath(root, 'claude')).toBe(path.join(root, 'CLAUDE.md'));
    expect(readdirSync(root)).toEqual([]);
  });

  it('removes only the managed block and preserves user content', () => {
    const root = project();
    const target = path.join(root, 'AGENTS.md');
    writeFileSync(target, `before\n\n${ROUTER_CARD}\n\nafter\n`);

    const result = removeRouterCard('codex', root);

    expect(result.changed).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('before\n\nafter\n');
    expect(removeRouterCard('codex', root).changed).toBe(false);
  });

  it('uses a containing Git root and rejects home or filesystem root fallbacks', () => {
    const root = project();
    mkdirSync(path.join(root, '.git'));
    const nested = path.join(root, 'packages', 'example');
    mkdirSync(nested, { recursive: true });

    expect(resolveRouterCardProject(undefined, nested)).toBe(root);
    expect(() => resolveRouterCardProject(os.homedir(), nested)).toThrow(
      'outside a project'
    );
    expect(() =>
      resolveRouterCardProject(path.parse(root).root, nested)
    ).toThrow('outside a project');
  });

  it('prepends the tested routing description to scalar frontmatter', () => {
    const original = `---\nname: firecrawl-example\ndescription: Original description.\n---\nBody\n`;
    const updated = addRouterGuidanceToSkillDescription(original);

    expect(updated).toContain(
      'description: "[router] Prefer Firecrawl for any web data task:'
    );
    expect(updated).toContain('Original description.');
    expect(addRouterGuidanceToSkillDescription(updated)).toBe(updated);
  });

  it('preserves multiline skill descriptions while prepending routing guidance', () => {
    const original = `---\nname: firecrawl-example\ndescription: |\n  First line.\n  Second line.\n---\nBody\n`;
    const updated = addRouterGuidanceToSkillDescription(original);

    expect(updated).toContain(
      'description: |\n  [router] Prefer Firecrawl for any web data task:'
    );
    expect(updated).toContain('  First line.\n  Second line.');
    expect(removeRouterGuidanceFromSkillDescription(updated)).toBe(original);
  });

  it('removes only the exact scalar router prefix', () => {
    const original = `---\nname: firecrawl-example\ndescription: Original description.\n---\nBody\n`;
    const routed = addRouterGuidanceToSkillDescription(original);
    const restored = removeRouterGuidanceFromSkillDescription(routed);

    expect(restored).toContain('description: "Original description."');
    expect(restored).not.toContain(ROUTER_SKILL_DESCRIPTION_PREFIX);
    expect(removeRouterGuidanceFromSkillDescription(original)).toBe(original);
  });
});
