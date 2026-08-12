/**
 * Detect installed AI coding agents and whether the firecrawl MCP server is
 * registered with them. Used by `firecrawl doctor`.
 *
 * Detection is best-effort: presence of the config dir/file is treated as
 * "installed". MCP registration is detected by parsing the JSON config and
 * looking for an entry named `firecrawl` in `mcpServers`.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export type AgentId =
  | 'cursor'
  | 'claude-code'
  | 'claude-desktop'
  | 'vscode'
  | 'windsurf'
  | 'codex'
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
  /** Config files to scan for an `mcpServers.firecrawl` entry. */
  mcpConfigPaths: (cwd: string) => string[];
}

const home = os.homedir();
const platform = os.platform();

function appSupportDir(name: string): string {
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

const SPECS: AgentSpec[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    presencePaths: () => [path.join(home, '.cursor')],
    mcpConfigPaths: (cwd) => [
      path.join(home, '.cursor', 'mcp.json'),
      path.join(cwd, '.cursor', 'mcp.json'),
    ],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    presencePaths: () => [
      path.join(home, '.claude'),
      path.join(home, '.claude.json'),
    ],
    mcpConfigPaths: (cwd) => [
      path.join(home, '.claude.json'),
      path.join(cwd, '.mcp.json'),
    ],
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    presencePaths: () => [appSupportDir('Claude')],
    mcpConfigPaths: () => [
      path.join(appSupportDir('Claude'), 'claude_desktop_config.json'),
    ],
  },
  {
    id: 'vscode',
    name: 'VS Code',
    presencePaths: () => [appSupportDir('Code'), path.join(home, '.vscode')],
    mcpConfigPaths: (cwd) => [
      path.join(appSupportDir('Code'), 'User', 'mcp.json'),
      path.join(appSupportDir('Code'), 'User', 'settings.json'),
      path.join(cwd, '.vscode', 'mcp.json'),
    ],
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    presencePaths: () => [
      path.join(home, '.codeium', 'windsurf'),
      path.join(home, '.windsurf'),
    ],
    mcpConfigPaths: () => [
      path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    presencePaths: () => [path.join(home, '.codex')],
    mcpConfigPaths: () => [
      path.join(home, '.codex', 'config.toml'),
      path.join(home, '.codex', 'mcp.json'),
    ],
  },
  {
    id: 'continue',
    name: 'Continue',
    presencePaths: () => [path.join(home, '.continue')],
    mcpConfigPaths: (cwd) => [
      path.join(home, '.continue', 'config.json'),
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
    const content = await fs.readFile(filePath, 'utf8');

    // TOML configs (Codex) — cheap substring check, good enough for a doctor
    // check that just needs a yes/no signal.
    if (filePath.endsWith('.toml')) {
      return /\[mcp_servers?\.firecrawl\]/i.test(content);
    }

    // JSON-ish configs. Some tools (VS Code settings.json) allow comments —
    // strip them before parsing.
    const stripped = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:\\])\/\/.*$/gm, '$1');

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      // Last resort: substring scan. Avoids false negatives when a config
      // uses an unusual JSON dialect.
      return /"firecrawl"\s*:/.test(content) && /mcpServers?/i.test(content);
    }

    return hasFirecrawlMcpEntry(parsed);
  } catch {
    return false;
  }
}

/**
 * Keys under which agents store their MCP server map: `mcpServers` for Claude
 * Code, Cursor, and Windsurf, `servers` for VS Code, `context_servers` for Zed.
 */
const SERVER_MAP_KEYS = new Set(['mcpServers', 'servers', 'context_servers']);

/**
 * Walk a parsed JSON config looking for a server map (or `mcp.servers`) that
 * contains a `firecrawl` key. Exported for testing.
 */
export function hasFirecrawlMcpEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (SERVER_MAP_KEYS.has(key) && child && typeof child === 'object') {
      if (Object.prototype.hasOwnProperty.call(child, 'firecrawl')) {
        return true;
      }
    }
    if (key === 'mcp' && child && typeof child === 'object') {
      const mcp = child as Record<string, unknown>;
      const servers = mcp.servers;
      if (
        servers &&
        typeof servers === 'object' &&
        Object.prototype.hasOwnProperty.call(servers, 'firecrawl')
      ) {
        return true;
      }
    }
    if (child && typeof child === 'object') {
      if (hasFirecrawlMcpEntry(child)) return true;
    }
  }
  return false;
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
        for (const cfg of configPaths) {
          // eslint-disable-next-line no-await-in-loop
          if (await fileHasFirecrawlMcp(cfg)) {
            mcpRegistered = true;
            break;
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
