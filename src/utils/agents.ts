/**
 * Detect installed AI coding agents and whether the firecrawl MCP server is
 * registered with them. Used by `firecrawl doctor`.
 *
 * Detection is best-effort: presence of the config dir/file is treated as
 * "installed". MCP registration for setup-supported agents uses the same
 * path helpers as `mcp-clients.ts`. OpenClaw is verified through
 * `openclaw mcp show firecrawl --json`.
 */

import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import {
  createMcpContext,
  MCP_CLIENTS,
  type McpClientId,
  type McpContext,
} from './mcp-clients';
import { tomlHasServer } from './mcp-install';

export type AgentId =
  | 'cursor'
  | 'claude-code'
  | 'claude-desktop'
  | 'vscode'
  | 'windsurf'
  | 'codex'
  | 'opencode'
  | 'hermes'
  | 'openclaw'
  | 'continue';

export interface AgentDetection {
  id: AgentId;
  name: string;
  installed: boolean;
  /** True when the firecrawl MCP server appears in this agent's config. */
  mcpRegistered: boolean;
  /** Configs that were inspected for MCP registration. */
  configPaths: string[];
}

interface AgentSpec {
  id: AgentId;
  name: string;
  /** Files/dirs that indicate the agent is installed. */
  presencePaths: () => string[];
  /** Config files to scan for a Firecrawl MCP server entry. */
  mcpConfigPaths: (cwd: string) => string[];
  /** When set, used instead of scanning mcpConfigPaths. */
  probeRegistered?: () => boolean;
}

const platform = os.platform();

function homedir(): string {
  return os.homedir();
}

function doctorContext(): McpContext {
  return createMcpContext();
}

function appSupportDir(name: string): string {
  const home = homedir();
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', name);
  }
  if (platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      name
    );
  }
  return path.join(home, '.config', name);
}

function fromClient(
  id: AgentId,
  clientId: McpClientId,
  extraConfigPaths?: (cwd: string, ctx: McpContext) => string[]
): AgentSpec {
  return {
    id,
    name: MCP_CLIENTS[clientId].name,
    presencePaths: () => MCP_CLIENTS[clientId].detectPaths(doctorContext()),
    mcpConfigPaths: (cwd) => {
      const ctx = doctorContext();
      return [
        MCP_CLIENTS[clientId].globalConfigPath(ctx),
        ...(extraConfigPaths?.(cwd, ctx) ?? []),
      ];
    },
  };
}

/**
 * OpenClaw's documented registry interface is the CLI, not the JSON5 config
 * file. Exit 0 plus a JSON object means the server is registered.
 */
export function openclawFirecrawlRegistered(): boolean {
  try {
    const stdout = execFileSync(
      'openclaw',
      ['mcp', 'show', 'firecrawl', '--json'],
      {
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object') return false;
    return (parsed as { ok?: unknown }).ok !== false;
  } catch {
    return false;
  }
}

const SPECS: AgentSpec[] = [
  fromClient('cursor', 'cursor', (cwd) => [
    path.join(cwd, '.cursor', 'mcp.json'),
  ]),
  fromClient('claude-code', 'claude', (cwd) => [path.join(cwd, '.mcp.json')]),
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    presencePaths: () => [appSupportDir('Claude')],
    mcpConfigPaths: () => [
      path.join(appSupportDir('Claude'), 'claude_desktop_config.json'),
    ],
  },
  fromClient('vscode', 'vscode', (cwd, ctx) => [
    path.join(
      path.dirname(MCP_CLIENTS.vscode.globalConfigPath(ctx)),
      'settings.json'
    ),
    path.join(cwd, '.vscode', 'mcp.json'),
  ]),
  {
    id: 'windsurf',
    name: 'Windsurf',
    presencePaths: () => [
      path.join(homedir(), '.codeium', 'windsurf'),
      path.join(homedir(), '.windsurf'),
    ],
    mcpConfigPaths: () => [
      path.join(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    ],
  },
  fromClient('codex', 'codex', (_cwd, ctx) => [
    path.join(
      path.dirname(MCP_CLIENTS.codex.globalConfigPath(ctx)),
      'mcp.json'
    ),
  ]),
  fromClient('opencode', 'opencode'),
  fromClient('hermes', 'hermes'),
  {
    id: 'openclaw',
    name: 'OpenClaw',
    presencePaths: () => [path.join(homedir(), '.openclaw')],
    mcpConfigPaths: () => [],
    probeRegistered: openclawFirecrawlRegistered,
  },
  {
    id: 'continue',
    name: 'Continue',
    presencePaths: () => [path.join(homedir(), '.continue')],
    mcpConfigPaths: (cwd) => [
      path.join(homedir(), '.continue', 'config.json'),
      path.join(cwd, '.continue', 'config.json'),
    ],
  },
];

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function fileHasFirecrawlMcp(filePath: string): Promise<boolean> {
  try {
    const stored = await fs.readFile(filePath, 'utf8');
    const content = stored.startsWith('\uFEFF') ? stored.slice(1) : stored;

    if (filePath.endsWith('.toml')) {
      return tomlHasServer(content, 'firecrawl');
    }

    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      const doc = parseDocument(content);
      return doc.errors.length === 0 && doc.hasIn(['mcp_servers', 'firecrawl']);
    }

    const errors: ParseError[] = [];
    const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
    if (errors.length > 0) return false;
    return hasFirecrawlMcpEntry(parsed);
  } catch {
    return false;
  }
}

/** True when `value` is a server map holding an entry named `firecrawl`. */
function isFirecrawlServerMap(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, 'firecrawl')
  );
}

/**
 * Claude Code keeps a per-project server map under `projects`, so `mcpServers`
 * is the one key that has to be matched at any depth.
 */
function hasNestedMcpServers(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;

  if (isFirecrawlServerMap(obj.mcpServers)) return true;
  return Object.values(obj).some(hasNestedMcpServers);
}

/**
 * Walk a parsed JSON config looking for a server map that contains a
 * `firecrawl` key. Exported for testing.
 */
export function hasFirecrawlMcpEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;

  // VS Code (`servers`, or `mcp.servers` in settings.json) and OpenCode (`mcp`)
  // both keep their map at the root. Matching those keys at any depth would let
  // an unrelated nested object that happens to hold a `firecrawl` property
  // report the server as registered when it is not.
  if (isFirecrawlServerMap(obj.servers) || isFirecrawlServerMap(obj.mcp)) {
    return true;
  }
  if (obj.mcp && typeof obj.mcp === 'object') {
    if (isFirecrawlServerMap((obj.mcp as Record<string, unknown>).servers)) {
      return true;
    }
  }

  return hasNestedMcpServers(obj);
}

/**
 * Detect every supported agent and whether firecrawl MCP is registered.
 */
export async function detectAgents(
  cwd: string = process.cwd()
): Promise<AgentDetection[]> {
  return Promise.all(
    SPECS.map(async (spec) => {
      const presence = await Promise.all(spec.presencePaths().map(pathExists));
      const installed = presence.some(Boolean);

      const configPaths = spec.mcpConfigPaths(cwd);
      let mcpRegistered = false;
      if (installed) {
        if (spec.probeRegistered) {
          mcpRegistered = spec.probeRegistered();
        } else {
          for (const cfg of configPaths) {
            // eslint-disable-next-line no-await-in-loop
            if (await fileHasFirecrawlMcp(cfg)) {
              mcpRegistered = true;
              break;
            }
          }
        }
      }

      return {
        id: spec.id,
        name: spec.name,
        installed,
        mcpRegistered,
        configPaths,
      };
    })
  );
}
