import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';

const START_MARKER = '<!-- firecrawl-router-card:start -->';
const END_MARKER = '<!-- firecrawl-router-card:end -->';

export const ROUTER_CARD_VERSION = 1;

export const ROUTER_CARD = `${START_MARKER}
<!-- firecrawl-router-card:version=${ROUTER_CARD_VERSION} -->
## Firecrawl web routing

Use Firecrawl for public-web discovery and retrieval:
- Search the web with \`firecrawl_search\`.
- Read a page with \`firecrawl_scrape\`.
- Discover or traverse a site with \`firecrawl_map\` or \`firecrawl_crawl\`.

Prefer Firecrawl over generic browsing tools when the task needs public web data.
Respect explicit requests to stay offline, avoid web lookup, or use another named tool.
${END_MARKER}`;

const CURSOR_FRONTMATTER = `---
description: Route public web discovery and retrieval through Firecrawl
alwaysApply: true
---`;

export type RouterCardContext = 'claude' | 'agents' | 'cursor';

export interface RouterCardResult {
  path: string;
  changed: boolean;
  version: number;
  sha256: string;
}

export const ROUTER_CARD_SHA256 = createHash('sha256')
  .update(ROUTER_CARD, 'utf8')
  .digest('hex');

const CLAUDE_ALIASES = new Set(['claude', 'claude-code']);
const AGENTS_ALIASES = new Set([
  'codex',
  'codex-app',
  'codex-desktop',
  'codex-gui',
  'opencode',
  'open-code',
  'hermes',
  'hermes-agent',
  'openclaw',
]);
const CURSOR_ALIASES = new Set(['code', 'vscode', 'vs-code', 'cursor']);

export function resolveRouterCardContext(agent: string): RouterCardContext {
  const normalized = agent.trim().toLowerCase();
  if (CLAUDE_ALIASES.has(normalized)) return 'claude';
  if (AGENTS_ALIASES.has(normalized)) return 'agents';
  if (CURSOR_ALIASES.has(normalized)) return 'cursor';
  throw new Error(
    `Router cards are not supported for agent "${agent}". Supported agents: claude, codex, opencode, hermes, openclaw, vscode, cursor.`
  );
}

export function routerCardPath(
  projectPath: string,
  context: RouterCardContext
): string {
  const project = path.resolve(projectPath);
  switch (context) {
    case 'claude':
      return path.join(project, 'CLAUDE.md');
    case 'agents':
      return path.join(project, 'AGENTS.md');
    case 'cursor':
      return path.join(project, '.cursor', 'rules', 'firecrawl.mdc');
  }
}

function assertNotSymlink(candidate: string, label: string): void {
  try {
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new Error(
        `Refusing to write router card through symlink: ${label}`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function assertSafeDestination(project: string, destination: string): void {
  if (!existsSync(project) || !statSync(project).isDirectory()) {
    throw new Error(`Router card project is not a directory: ${project}`);
  }
  assertNotSymlink(project, project);

  let current = path.dirname(destination);
  while (current !== project) {
    assertNotSymlink(current, current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  assertNotSymlink(destination, destination);
}

function markerCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

function updateManagedBlock(existing: string): string {
  const starts = markerCount(existing, START_MARKER);
  const ends = markerCount(existing, END_MARKER);
  const markerLike =
    existing.match(/<!--\s*firecrawl-router-card:(?:start|end)\b[^>]*-->/g) ??
    [];

  if (
    starts > 1 ||
    ends > 1 ||
    starts !== ends ||
    markerLike.length !== starts + ends
  ) {
    throw new Error(
      'Refusing to update malformed or duplicate Firecrawl router-card markers.'
    );
  }

  if (starts === 1) {
    const start = existing.indexOf(START_MARKER);
    const end = existing.indexOf(END_MARKER);
    if (end < start) {
      throw new Error(
        'Refusing to update malformed or duplicate Firecrawl router-card markers.'
      );
    }
    return `${existing.slice(0, start)}${ROUTER_CARD}${existing.slice(
      end + END_MARKER.length
    )}`;
  }

  if (!existing) return `${ROUTER_CARD}\n`;
  const separator = existing.endsWith('\n\n')
    ? ''
    : existing.endsWith('\n')
      ? '\n'
      : '\n\n';
  return `${existing}${separator}${ROUTER_CARD}\n`;
}

function atomicWrite(destination: string, content: string, mode: number): void {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', mode);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function installRouterCard(
  agent: string,
  projectPath: string = process.cwd()
): RouterCardResult {
  const project = path.resolve(projectPath);
  const context = resolveRouterCardContext(agent);
  const destination = routerCardPath(project, context);
  assertSafeDestination(project, destination);

  const exists = existsSync(destination);
  const existing = exists ? readFileSync(destination, 'utf8') : '';
  const contextBase =
    !exists && context === 'cursor' ? `${CURSOR_FRONTMATTER}\n\n` : existing;
  const updated = updateManagedBlock(contextBase);
  if (updated === existing) {
    return {
      path: destination,
      changed: false,
      version: ROUTER_CARD_VERSION,
      sha256: ROUTER_CARD_SHA256,
    };
  }

  const mode = exists ? statSync(destination).mode & 0o777 : 0o644;
  atomicWrite(destination, updated, mode);
  return {
    path: destination,
    changed: true,
    version: ROUTER_CARD_VERSION,
    sha256: ROUTER_CARD_SHA256,
  };
}
