import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import stripJsonComments from 'strip-json-comments';

const CLAUDE_DENY_TOOLS = ['WebSearch', 'WebFetch'] as const;
const CODEX_WEB_SEARCH_DISABLED = 'web_search = "disabled"';

export type WebAgent = 'Claude Code' | 'Codex';

export const WEB_AGENTS: readonly WebAgent[] = ['Claude Code', 'Codex'];

export interface WebDefaultsOptions {
  undo?: boolean;
  /** Limit configuration to these agents. Defaults to all agents. */
  agents?: readonly WebAgent[];
}

export interface WebDefaultResult {
  agent: WebAgent;
  path: string;
  changed: boolean;
  skipped?: boolean;
  message: string;
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function configureClaudeDefaults(
  undo: boolean
): Promise<WebDefaultResult> {
  const filePath = path.join(os.homedir(), '.claude', 'settings.json');
  const existing = await readText(filePath);
  let config: Record<string, unknown> = {};

  if (existing && existing.trim()) {
    try {
      config = JSON.parse(stripJsonComments(existing));
    } catch {
      return {
        agent: 'Claude Code',
        path: filePath,
        changed: false,
        skipped: true,
        message:
          'Skipped Claude Code settings because settings.json is not valid JSON',
      };
    }
  }

  const permissions =
    config.permissions && typeof config.permissions === 'object'
      ? (config.permissions as Record<string, unknown>)
      : {};
  const deny = Array.isArray(permissions.deny) ? [...permissions.deny] : [];

  let nextDeny: unknown[];
  const denyTools = new Set<string>(CLAUDE_DENY_TOOLS);
  if (undo) {
    nextDeny = deny.filter(
      (tool) => typeof tool !== 'string' || !denyTools.has(tool)
    );
  } else {
    const existingDeny = new Set(
      deny.filter((tool): tool is string => typeof tool === 'string')
    );
    nextDeny = [...deny];
    for (const tool of CLAUDE_DENY_TOOLS) {
      if (!existingDeny.has(tool)) nextDeny.push(tool);
    }
  }

  const changed = JSON.stringify(deny) !== JSON.stringify(nextDeny);

  if (!changed) {
    return {
      agent: 'Claude Code',
      path: filePath,
      changed: false,
      message: undo
        ? 'Claude Code native WebSearch/WebFetch were already enabled'
        : 'Claude Code already denies native WebSearch/WebFetch',
    };
  }

  const nextPermissions = { ...permissions };
  if (nextDeny.length > 0) {
    nextPermissions.deny = nextDeny;
  } else {
    delete nextPermissions.deny;
  }

  const nextConfig = { ...config };
  if (Object.keys(nextPermissions).length > 0) {
    nextConfig.permissions = nextPermissions;
  } else {
    delete nextConfig.permissions;
  }

  await writeText(filePath, `${JSON.stringify(nextConfig, null, 2)}\n`);

  return {
    agent: 'Claude Code',
    path: filePath,
    changed: true,
    message: undo
      ? 'Enabled Claude Code native WebSearch/WebFetch'
      : 'Disabled Claude Code native WebSearch/WebFetch',
  };
}

function setCodexWebSearchDisabled(content: string): {
  content: string;
  changed: boolean;
} {
  if (content.trim().length === 0) {
    return { content: `${CODEX_WEB_SEARCH_DISABLED}\n`, changed: true };
  }

  const lines = content.split(/\r?\n/);
  const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTableIndex === -1 ? lines.length : firstTableIndex;

  for (let index = 0; index < rootEnd; index += 1) {
    if (/^\s*web_search\s*=/.test(lines[index])) {
      if (lines[index] === CODEX_WEB_SEARCH_DISABLED) {
        return { content, changed: false };
      }
      lines[index] = CODEX_WEB_SEARCH_DISABLED;
      return { content: lines.join('\n'), changed: true };
    }
  }

  lines.splice(rootEnd, 0, CODEX_WEB_SEARCH_DISABLED);
  return { content: lines.join('\n'), changed: true };
}

function removeCodexWebSearchDisabled(content: string): {
  content: string;
  changed: boolean;
} {
  const lines = content.split(/\r?\n/);
  const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
  const rootEnd = firstTableIndex === -1 ? lines.length : firstTableIndex;
  const nextLines = lines.filter((line, index) => {
    if (index >= rootEnd) return true;
    return !/^web_search\s*=\s*["']disabled["']\s*(#.*)?$/.test(line.trim());
  });
  const next = nextLines.join('\n').replace(/\n{3,}/g, '\n\n');
  return { content: next, changed: next !== content };
}

async function configureCodexDefaults(
  undo: boolean
): Promise<WebDefaultResult> {
  const filePath = path.join(os.homedir(), '.codex', 'config.toml');
  const existing = (await readText(filePath)) ?? '';
  const result = undo
    ? removeCodexWebSearchDisabled(existing)
    : setCodexWebSearchDisabled(existing);

  if (!result.changed) {
    return {
      agent: 'Codex',
      path: filePath,
      changed: false,
      message: undo
        ? 'Codex native web search was already enabled'
        : 'Codex native web search was already disabled',
    };
  }

  await writeText(filePath, result.content);

  return {
    agent: 'Codex',
    path: filePath,
    changed: true,
    message: undo
      ? 'Enabled Codex native web search'
      : 'Disabled Codex native web search',
  };
}

export async function configureWebDefaults(
  options: WebDefaultsOptions = {}
): Promise<WebDefaultResult[]> {
  const undo = Boolean(options.undo);
  const selected = new Set<WebAgent>(options.agents ?? WEB_AGENTS);
  const tasks: Promise<WebDefaultResult>[] = [];
  if (selected.has('Claude Code')) tasks.push(configureClaudeDefaults(undo));
  if (selected.has('Codex')) tasks.push(configureCodexDefaults(undo));
  return Promise.all(tasks);
}
