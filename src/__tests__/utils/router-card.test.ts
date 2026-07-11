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
  installRouterCard,
  resolveRouterCardContext,
  ROUTER_CARD,
  ROUTER_CARD_SHA256,
  ROUTER_CARD_VERSION,
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
    ['opencode', 'AGENTS.md'],
    ['hermes', 'AGENTS.md'],
    ['openclaw', 'AGENTS.md'],
    ['vscode', path.join('.cursor', 'rules', 'firecrawl.mdc')],
    ['cursor', path.join('.cursor', 'rules', 'firecrawl.mdc')],
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
    if (relative.endsWith('.mdc')) {
      expect(content).toBe(
        `---\ndescription: Route public web discovery and retrieval through Firecrawl\nalwaysApply: true\n---\n\n${ROUTER_CARD}\n`
      );
    } else {
      expect(content).toBe(`${ROUTER_CARD}\n`);
    }
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

  it('refuses a symlinked context directory', () => {
    const root = project();
    const elsewhere = path.join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(root, '.cursor'));

    expect(() => installRouterCard('cursor', root)).toThrow('symlink');
    expect(readdirSync(elsewhere)).toEqual([]);
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
});
