/**
 * Makes Firecrawl the preferred web provider for the agents that support it.
 *
 * Edits here are non-destructive by policy. A value the user set themselves is
 * left alone and reported back, never overwritten: `web_search` is read from
 * the TOML AST rather than matched line by line, and Claude's settings are
 * patched through a JSONC-aware editor so comments and formatting survive.
 *
 * Every routine can run as a dry run, so the command can show the exact edit
 * and get confirmation before anything reaches disk.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  type ParseError,
} from 'jsonc-parser';
import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser';
import { claudeConfigDir, codexHome, createMcpContext } from './mcp-clients';

const CLAUDE_DENY_TOOLS = ['WebSearch', 'WebFetch'] as const;
const CODEX_WEB_SEARCH_KEY = 'web_search';
const CODEX_WEB_SEARCH_VALUE = 'disabled';
const CODEX_WEB_SEARCH_DISABLED = `${CODEX_WEB_SEARCH_KEY} = "${CODEX_WEB_SEARCH_VALUE}"`;

export type WebAgent = 'Claude Code' | 'Codex';

export const WEB_AGENTS: readonly WebAgent[] = ['Claude Code', 'Codex'];

export interface WebDefaultsOptions {
  undo?: boolean;
  /** Limit configuration to these agents. Defaults to all agents. */
  agents?: readonly WebAgent[];
  /** Compute the edit and report it without touching the filesystem. */
  dryRun?: boolean;
}

export interface WebDefaultResult {
  agent: WebAgent;
  path: string;
  changed: boolean;
  skipped?: boolean;
  /** The user set this key themselves, so it was read and left as-is. */
  preserved?: boolean;
  message: string;
  /** The exact edit, shown for confirmation before anything is written. */
  preview?: string;
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

/* -------------------------------------------------------------- Claude Code */

async function configureClaudeDefaults(
  undo: boolean,
  dryRun: boolean
): Promise<WebDefaultResult> {
  // Claude Code relocates its whole config tree when CLAUDE_CONFIG_DIR is set,
  // and the MCP writer already follows it. Both halves have to land in the
  // same place or the switch is written where the agent will not read it.
  const filePath = path.join(
    claudeConfigDir(createMcpContext()),
    'settings.json'
  );
  const stored = await readText(filePath);
  // A byte order mark parses as an error even though the document is valid.
  const bom = stored?.startsWith('\uFEFF') ? '\uFEFF' : '';
  const raw = (bom ? stored!.slice(1) : stored) ?? '';

  let config: Record<string, unknown> = {};
  if (raw.trim()) {
    const errors: ParseError[] = [];
    const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
    if (
      errors.length > 0 ||
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        agent: 'Claude Code',
        path: filePath,
        changed: false,
        skipped: true,
        message:
          'Skipped Claude Code settings because settings.json is not valid JSON',
      };
    }
    config = parsed as Record<string, unknown>;
  }

  const rawPermissions = config.permissions;
  const permissions =
    rawPermissions &&
    typeof rawPermissions === 'object' &&
    !Array.isArray(rawPermissions)
      ? (rawPermissions as Record<string, unknown>)
      : {};
  const deny = Array.isArray(permissions.deny) ? [...permissions.deny] : [];
  const denyTools = new Set<string>(CLAUDE_DENY_TOOLS);

  let nextDeny: unknown[];
  if (undo) {
    nextDeny = deny.filter(
      (tool) => typeof tool !== 'string' || !denyTools.has(tool)
    );
  } else {
    // Additive: entries the user denied for their own reasons are untouched.
    const present = new Set(
      deny.filter((tool): tool is string => typeof tool === 'string')
    );
    nextDeny = [...deny];
    for (const tool of CLAUDE_DENY_TOOLS) {
      if (!present.has(tool)) nextDeny.push(tool);
    }
  }

  if (JSON.stringify(deny) === JSON.stringify(nextDeny)) {
    return {
      agent: 'Claude Code',
      path: filePath,
      changed: false,
      message: undo
        ? 'Claude Code native WebSearch/WebFetch were already enabled'
        : 'Claude Code already denies native WebSearch/WebFetch',
    };
  }

  const touched = CLAUDE_DENY_TOOLS.filter((tool) =>
    undo ? deny.includes(tool) : !deny.includes(tool)
  );
  const preview = `permissions.deny ${undo ? '-' : '+'}= ${JSON.stringify(touched)}`;

  if (!dryRun) {
    let next: string;
    if (raw.trim() === '') {
      next = `${JSON.stringify({ permissions: { deny: nextDeny } }, null, 2)}\n`;
    } else {
      // Patch the leaf so comments, key order, and formatting all survive.
      // `modify` cannot descend through a null, array, or scalar, so a
      // `permissions` of the wrong shape has the whole key replaced instead.
      const formattingOptions = { insertSpaces: true, tabSize: 2 };
      const permissionsIsObject =
        rawPermissions !== undefined &&
        rawPermissions !== null &&
        typeof rawPermissions === 'object' &&
        !Array.isArray(rawPermissions);
      const edits =
        rawPermissions === undefined || permissionsIsObject
          ? modify(
              raw,
              ['permissions', 'deny'],
              nextDeny.length > 0 ? nextDeny : undefined,
              { formattingOptions }
            )
          : modify(
              raw,
              ['permissions'],
              nextDeny.length > 0
                ? { ...permissions, deny: nextDeny }
                : permissions,
              { formattingOptions }
            );
      next = applyEdits(raw, edits);
      if (!next.endsWith('\n')) next += '\n';
    }
    await writeText(filePath, `${bom}${next}`);
  }

  return {
    agent: 'Claude Code',
    path: filePath,
    changed: true,
    preview,
    message: undo
      ? 'Enabled Claude Code native WebSearch/WebFetch'
      : 'Disabled Claude Code native WebSearch/WebFetch',
  };
}

/* --------------------------------------------------------------------- Codex */

/** Offsets of the whole line containing `index`, newline included. */
function lineBounds(
  raw: string,
  index: number
): { start: number; end: number } {
  const start = raw.lastIndexOf('\n', Math.max(index - 1, 0)) + 1;
  const newline = raw.indexOf('\n', index);
  return { start, end: newline === -1 ? raw.length : newline + 1 };
}

/**
 * The root-level `web_search` assignment, if the user has one. Root scope ends
 * at the first table header, so the scan stops there rather than matching a
 * `web_search` that belongs to some other table.
 */
function rootWebSearchNode(ast: AST.TOMLProgram): AST.TOMLKeyValue | undefined {
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLTable') break;
    if (node.type !== 'TOMLKeyValue') continue;
    const keys = node.key.keys;
    if (keys.length !== 1) continue;
    const key = keys[0] as { name?: string; value?: unknown };
    const name = key.name ?? String(key.value);
    if (name === CODEX_WEB_SEARCH_KEY) return node;
  }
  return undefined;
}

/**
 * Insert after the last root key so the line cannot land inside a table.
 *
 * The offset is taken from the END of that key's value, not the start: a root
 * value can span lines (an inline array, a triple-quoted string), and anchoring
 * on the first line would splice the new key into the middle of it.
 */
function rootInsertOffset(ast: AST.TOMLProgram, raw: string): number {
  let last: AST.TOMLKeyValue | undefined;
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLTable') break;
    if (node.type === 'TOMLKeyValue') last = node;
  }
  return last ? lineBounds(raw, last.range[1] - 1).end : 0;
}

async function configureCodexDefaults(
  undo: boolean,
  dryRun: boolean
): Promise<WebDefaultResult> {
  const filePath = path.join(codexHome(createMcpContext()), 'config.toml');
  const raw = (await readText(filePath)) ?? '';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const base = {
    agent: 'Codex' as const,
    path: filePath,
  };

  if (raw.trim() === '') {
    if (undo) {
      return {
        ...base,
        changed: false,
        message: 'Codex native web search was already enabled',
      };
    }
    if (!dryRun)
      await writeText(filePath, `${CODEX_WEB_SEARCH_DISABLED}${eol}`);
    return {
      ...base,
      changed: true,
      preview: `+ ${CODEX_WEB_SEARCH_DISABLED}`,
      message: 'Disabled Codex native web search',
    };
  }

  let ast: AST.TOMLProgram;
  try {
    ast = parseTOML(raw);
  } catch (error) {
    // A config we cannot read is a config we must not rewrite.
    return {
      ...base,
      changed: false,
      skipped: true,
      message: `Skipped Codex config because config.toml is not valid TOML: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const current = (getStaticTOMLValue(ast) as Record<string, unknown>)[
    CODEX_WEB_SEARCH_KEY
  ];
  const node = rootWebSearchNode(ast);

  if (undo) {
    // Only ever remove the value this command writes. Anything else is the
    // user's own setting and restoring native search is not worth clobbering it.
    if (!node || current !== CODEX_WEB_SEARCH_VALUE) {
      return {
        ...base,
        changed: false,
        message: 'Codex native web search was already enabled',
      };
    }
    if (!dryRun) {
      const { start, end } = lineBounds(raw, node.range[0]);
      await writeText(filePath, `${raw.slice(0, start)}${raw.slice(end)}`);
    }
    return {
      ...base,
      changed: true,
      preview: `- ${CODEX_WEB_SEARCH_DISABLED}`,
      message: 'Enabled Codex native web search',
    };
  }

  if (current === CODEX_WEB_SEARCH_VALUE) {
    return {
      ...base,
      changed: false,
      message: 'Codex native web search was already disabled',
    };
  }

  if (node) {
    // The user set this themselves. Report it and move on.
    return {
      ...base,
      changed: false,
      preserved: true,
      message: `Left Codex ${CODEX_WEB_SEARCH_KEY} = ${JSON.stringify(current)} as you set it`,
    };
  }

  const offset = rootInsertOffset(ast, raw);
  const line = `${CODEX_WEB_SEARCH_DISABLED}${eol}`;
  const head = raw.slice(0, offset);
  const needsBreak = head.length > 0 && !head.endsWith('\n');
  const next = `${head}${needsBreak ? eol : ''}${line}${raw.slice(offset)}`;

  // The edit is textual, so the result is re-read before it is trusted. A
  // config we would leave unparseable is reported instead of written.
  try {
    parseTOML(next);
  } catch (error) {
    return {
      ...base,
      changed: false,
      skipped: true,
      message: `Skipped Codex config because the edit would not parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!dryRun) await writeText(filePath, next);
  return {
    ...base,
    changed: true,
    preview: `+ ${CODEX_WEB_SEARCH_DISABLED}`,
    message: 'Disabled Codex native web search',
  };
}

export async function configureWebDefaults(
  options: WebDefaultsOptions = {}
): Promise<WebDefaultResult[]> {
  const undo = Boolean(options.undo);
  const dryRun = Boolean(options.dryRun);
  const selected = new Set<WebAgent>(options.agents ?? WEB_AGENTS);
  const tasks: Promise<WebDefaultResult>[] = [];
  if (selected.has('Claude Code')) {
    tasks.push(configureClaudeDefaults(undo, dryRun));
  }
  if (selected.has('Codex')) tasks.push(configureCodexDefaults(undo, dryRun));
  return Promise.all(tasks);
}
