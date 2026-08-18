/**
 * Registry of AI coding agents that can host the hosted Firecrawl MCP server.
 *
 * Every agent reads a config file that maps a server name to a connection
 * entry, but the file location, the key holding that map, and the shape of the
 * entry itself differ per agent. This module is the single place those
 * differences live; `mcp-install.ts` does the writing.
 *
 * Credentials are never handled here. A stored API key must not end up as a
 * literal in a config file, so this module only ever emits an indirect
 * reference to `FIRECRAWL_API_KEY` using the syntax a given agent is known to
 * expand. An agent is only supported once that syntax is verified.
 */

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  promises as fs,
  statSync,
} from 'fs';
import os from 'os';
import path from 'path';

export const FIRECRAWL_MCP_URL = 'https://mcp.firecrawl.dev/v2/mcp';
/**
 * Browser sign-in endpoint. A different server URL, not a different header, so
 * choosing it is what puts an agent into the sign-in flow.
 */
export const FIRECRAWL_MCP_OAUTH_URL = 'https://mcp.firecrawl.dev/v2/mcp-oauth';
export const MCP_SERVER_NAME = 'firecrawl';
export const API_KEY_ENV_VAR = 'FIRECRAWL_API_KEY';

export type McpClientId =
  | 'claude'
  | 'cursor'
  | 'vscode'
  | 'codex'
  | 'opencode'
  | 'hermes';

/**
 * Agent launchers that own their MCP configuration rather than reading a file
 * we write. They are offered alongside the editors but installed differently.
 *
 * OpenClaw is the only one: its config is JSON5, which the editor we patch JSON
 * with cannot read, and `openclaw mcp set` is the vendor-documented path that
 * also normalises the entry. Hermes reads plain YAML, so it is a client.
 */
export type McpLauncherId = 'openclaw';

export type McpTargetId = McpClientId | McpLauncherId;

/**
 * `env` writes an indirect reference to `FIRECRAWL_API_KEY`, which only works
 * when that variable is exported in the environment the agent runs under.
 * `keyless` writes no credential at all. `oauth` writes no credential either
 * and points the agent at the sign-in endpoint, which it authenticates against
 * through a browser flow the person completes in the agent itself.
 */
export type McpAuthMode = 'env' | 'keyless' | 'oauth';

export interface McpContext {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  auth: McpAuthMode;
}

/** Process-backed context for setup, detection, and doctor. */
export function createMcpContext(
  overrides: Partial<McpContext> = {}
): McpContext {
  return {
    home: overrides.home ?? os.homedir(),
    cwd: overrides.cwd ?? process.cwd(),
    platform: overrides.platform ?? process.platform,
    env: overrides.env ?? process.env,
    auth: overrides.auth ?? 'keyless',
  };
}

function envOverride(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value && value !== '' ? value : undefined;
}

/** Codex reads `$CODEX_HOME` when set, otherwise `~/.codex`. */
export function codexHome(ctx: McpContext): string {
  return envOverride(ctx.env, 'CODEX_HOME') ?? path.join(ctx.home, '.codex');
}

/** Hermes reads `$HERMES_HOME` when set, otherwise `~/.hermes`. */
export function hermesHome(ctx: McpContext): string {
  return envOverride(ctx.env, 'HERMES_HOME') ?? path.join(ctx.home, '.hermes');
}

/**
 * How an agent is put into the browser sign-in flow. Absent when that flow is
 * not verified for the agent, which keeps `--oauth` from writing an entry that
 * reports success and then exposes no tools.
 */
export interface McpOauthSpec {
  /** Entry fields the agent needs before it will start the flow. */
  entry?: Record<string, unknown>;
  /**
   * The command that signs this agent in, and only when one is required.
   * Agents that surface the prompt themselves leave this unset: repeating
   * their own instruction back at them is noise, not help.
   */
  nextStep?: string;
}

export interface McpClient {
  id: McpClientId;
  name: string;
  format: 'json' | 'toml' | 'yaml';
  /** Key of the map holding MCP servers in this agent's config. */
  serversKey: string;
  globalConfigPath: (ctx: McpContext) => string;
  /**
   * Mode for a config file we create. Only applied on creation, so a file the
   * user already owns keeps the permissions they gave it.
   */
  createMode?: number;
  buildEntry: (ctx: McpContext) => Record<string, unknown>;
  /** Absent when browser sign-in is not verified for this agent. */
  oauth?: McpOauthSpec;
  /** Paths whose existence means the agent is installed. */
  detectPaths: (ctx: McpContext) => string[];
}

/**
 * Header values that reference the environment variable rather than its value.
 * The syntax differs per agent and only these forms are verified, so anything
 * missing from this map falls back to keyless rather than risking a literal.
 */
const ENV_HEADER = {
  /** Plain shell-style expansion. */
  shell: `Bearer \${${API_KEY_ENV_VAR}}`,
  /** Editor-style expansion used by Cursor and VS Code. */
  editor: `Bearer \${env:${API_KEY_ENV_VAR}}`,
  /** Brace form used by OpenCode. */
  brace: `Bearer {env:${API_KEY_ENV_VAR}}`,
} as const;

function appSupportDir(ctx: McpContext, name: string): string {
  if (ctx.platform === 'darwin') {
    return path.join(ctx.home, 'Library', 'Application Support', name);
  }
  if (ctx.platform === 'win32') {
    const appData = ctx.env.APPDATA;
    const base =
      appData && appData !== ''
        ? appData
        : path.join(ctx.home, 'AppData', 'Roaming');
    return path.join(base, name);
  }
  return path.join(ctx.home, '.config', name);
}

/** Claude Code relocates its whole config tree when CLAUDE_CONFIG_DIR is set. */
export function claudeConfigDir(ctx: McpContext): string {
  const override = ctx.env.CLAUDE_CONFIG_DIR;
  return override && override !== ''
    ? override
    : path.join(ctx.home, '.claude');
}

function claudeGlobalConfigPath(ctx: McpContext): string {
  const override = ctx.env.CLAUDE_CONFIG_DIR;
  return override && override !== ''
    ? path.join(override, '.claude.json')
    : path.join(ctx.home, '.claude.json');
}

function vscodeUserDir(ctx: McpContext): string {
  return path.join(appSupportDir(ctx, 'Code'), 'User');
}

/** Sign-in uses a separate endpoint, so the URL follows the auth mode. */
export function firecrawlMcpUrl(ctx: McpContext): string {
  return ctx.auth === 'oauth' ? FIRECRAWL_MCP_OAUTH_URL : FIRECRAWL_MCP_URL;
}

/** Attach the agent's env-reference header when authenticating that way. */
function withEnvAuth(
  ctx: McpContext,
  entry: Record<string, unknown>,
  header: string
): Record<string, unknown> {
  if (ctx.auth !== 'env') return entry;
  return { ...entry, headers: { Authorization: header } };
}

export const MCP_CLIENTS: Record<McpClientId, McpClient> = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    format: 'json',
    serversKey: 'mcpServers',
    globalConfigPath: claudeGlobalConfigPath,
    buildEntry: (ctx) =>
      withEnvAuth(
        ctx,
        { type: 'http', url: firecrawlMcpUrl(ctx) },
        ENV_HEADER.shell
      ),
    // Claude Code flags a server that answers 401 and shows a startup notice
    // pointing at `/mcp`, so setup has nothing to add.
    detectPaths: (ctx) => [claudeConfigDir(ctx), claudeGlobalConfigPath(ctx)],
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    format: 'json',
    serversKey: 'mcpServers',
    globalConfigPath: (ctx) => path.join(ctx.home, '.cursor', 'mcp.json'),
    buildEntry: (ctx) =>
      withEnvAuth(ctx, { url: firecrawlMcpUrl(ctx) }, ENV_HEADER.editor),
    // Cursor marks the server as needing login in its own MCP settings.
    detectPaths: (ctx) => [path.join(ctx.home, '.cursor')],
  },
  vscode: {
    id: 'vscode',
    name: 'VS Code',
    format: 'json',
    serversKey: 'servers',
    globalConfigPath: (ctx) => path.join(vscodeUserDir(ctx), 'mcp.json'),
    buildEntry: (ctx) =>
      withEnvAuth(
        ctx,
        { type: 'http', url: firecrawlMcpUrl(ctx) },
        ENV_HEADER.editor
      ),
    // `User` is created on first launch, so requiring it misses an install
    // that has only been unpacked. These are the markers doctor already uses.
    // VS Code registers its own client and opens the browser when the server
    // starts, and documents no sign-in command to point at.
    detectPaths: (ctx) => [
      appSupportDir(ctx, 'Code'),
      path.join(ctx.home, '.vscode'),
    ],
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    format: 'toml',
    serversKey: 'mcp_servers',
    globalConfigPath: (ctx) => path.join(codexHome(ctx), 'config.toml'),
    // Codex resolves the bearer token from the environment by variable name,
    // so it authenticates without a header template.
    buildEntry: (ctx) =>
      ctx.auth === 'env'
        ? { url: firecrawlMcpUrl(ctx), bearer_token_env_var: API_KEY_ENV_VAR }
        : { url: firecrawlMcpUrl(ctx) },
    // Codex registers the server but does not start the flow on its own. The
    // desktop app and the IDE extension share this config file and offer an
    // Authenticate action; only the CLI needs the command.
    oauth: {
      nextStep: 'codex mcp login firecrawl, or Authenticate in Codex settings',
    },
    detectPaths: (ctx) => [codexHome(ctx)],
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    format: 'json',
    serversKey: 'mcp',
    globalConfigPath: (ctx) =>
      path.join(ctx.home, '.config', 'opencode', 'opencode.json'),
    buildEntry: (ctx) =>
      withEnvAuth(
        ctx,
        { type: 'remote', url: firecrawlMcpUrl(ctx), enabled: true },
        ENV_HEADER.brace
      ),
    // OpenCode prompts on first use, so there is nothing to tell the user.
    detectPaths: (ctx) => [path.join(ctx.home, '.config', 'opencode')],
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes Agent',
    format: 'yaml',
    serversKey: 'mcp_servers',
    globalConfigPath: (ctx) => path.join(hermesHome(ctx), 'config.yaml'),
    // Hermes keeps secrets in ~/.hermes/.env rather than here, but the rest of
    // this file is the user's, so a file we create starts owner-only.
    createMode: 0o600,
    // Documented HTTP server shape: `url` plus a `headers` mapping. Hermes
    // expands `${VAR}` in any string value in a server entry.
    buildEntry: (ctx) =>
      withEnvAuth(ctx, { url: firecrawlMcpUrl(ctx) }, ENV_HEADER.shell),
    // Hermes only starts the flow when the entry opts into it. A running
    // session reloads this file on a 30s timer, which is not long enough to
    // finish the flow, so the login command has to run outside that session.
    oauth: {
      entry: { auth: 'oauth' },
      nextStep: 'hermes mcp login firecrawl, from a new terminal',
    },
    detectPaths: (ctx) => [hermesHome(ctx)],
  },
};

export const ALL_MCP_CLIENT_IDS: readonly McpClientId[] = [
  'claude',
  'cursor',
  'vscode',
  'codex',
  'opencode',
  'hermes',
];

export const MCP_LAUNCHER_NAMES: Record<McpLauncherId, string> = {
  openclaw: 'OpenClaw',
};

/** Sign-in support for launchers, held apart because they take no config write. */
export const MCP_LAUNCHER_OAUTH: Partial<Record<McpLauncherId, McpOauthSpec>> =
  {
    openclaw: {
      // A static Authorization header is ignored once this is set, and the
      // login command only runs for servers configured with it.
      entry: { auth: 'oauth' },
      nextStep: 'openclaw mcp login firecrawl',
    },
  };

export const ALL_MCP_LAUNCHER_IDS: readonly McpLauncherId[] = ['openclaw'];

export const ALL_MCP_TARGET_IDS: readonly McpTargetId[] = [
  ...ALL_MCP_CLIENT_IDS,
  ...ALL_MCP_LAUNCHER_IDS,
];

export function isMcpLauncherId(id: McpTargetId): id is McpLauncherId {
  return (ALL_MCP_LAUNCHER_IDS as readonly string[]).includes(id);
}

export function mcpTargetName(id: McpTargetId): string {
  return isMcpLauncherId(id) ? MCP_LAUNCHER_NAMES[id] : MCP_CLIENTS[id].name;
}

/**
 * Look for an executable across PATH without spawning it. Launchers are CLIs,
 * so their presence on PATH is the signal, but running `--version` during a
 * picker would be slow and have side effects.
 *
 * Existence is not enough: a leftover non-executable file or a directory of
 * the same name would put OpenClaw in the picker on a machine that cannot
 * run it. Windows treats PATHEXT-matched files as launchable; POSIX needs
 * the execute bit.
 */
function isRunnablePath(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binaryOnPath(name: string, ctx: McpContext): boolean {
  const extensions =
    ctx.platform === 'win32'
      ? (ctx.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  const entries = (ctx.env.PATH ?? ctx.env.Path ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const entry of entries) {
    for (const extension of extensions) {
      if (isRunnablePath(path.join(entry, `${name}${extension}`), ctx.platform))
        return true;
    }
  }
  return false;
}

/**
 * Detection prefers a false negative to a false positive: the picker only
 * lists agents that look installed, so a miss means the user passes a flag
 * (`--cursor`) instead of seeing an agent they do not have.
 *
 * Hermes is detected by its config directory alone, through `detectPaths`. Its
 * name is also used by an unrelated JavaScript engine that ships with common
 * toolchains, so a PATH lookup reports it present on machines without it.
 */
const LAUNCHER_DETECT: Record<McpLauncherId, (ctx: McpContext) => boolean> = {
  openclaw: (ctx) =>
    existsSync(path.join(ctx.home, '.openclaw')) ||
    binaryOnPath('openclaw', ctx),
};

/** Launchers present on this machine, in registry order. */
export function detectMcpLaunchers(ctx: McpContext): McpLauncherId[] {
  return ALL_MCP_LAUNCHER_IDS.filter((id) => LAUNCHER_DETECT[id](ctx));
}

/** Aliases accepted by `--agent`, including the names `firecrawl launch` uses. */
const CLIENT_ALIASES: Record<string, McpClientId> = {
  claude: 'claude',
  'claude-code': 'claude',
  claudecode: 'claude',
  cursor: 'cursor',
  vscode: 'vscode',
  'vs-code': 'vscode',
  code: 'vscode',
  codex: 'codex',
  'codex-app': 'codex',
  'codex-desktop': 'codex',
  'codex-gui': 'codex',
  opencode: 'opencode',
  'open-code': 'opencode',
  hermes: 'hermes',
  'hermes-agent': 'hermes',
};

export function resolveMcpClientId(agent: string): McpClientId | undefined {
  const alias = agent.trim().toLowerCase();
  // An object literal inherits `__proto__` and `constructor`, so looking either
  // one up returns something truthy. Without this guard those two names read as
  // a resolved agent and crash later instead of being rejected as unknown.
  return Object.prototype.hasOwnProperty.call(CLIENT_ALIASES, alias)
    ? CLIENT_ALIASES[alias]
    : undefined;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Agents that look installed on this machine, in registry order. */
export async function detectMcpClients(
  ctx: McpContext
): Promise<McpClientId[]> {
  const detected = await Promise.all(
    ALL_MCP_CLIENT_IDS.map(async (id) => {
      const found = await Promise.all(
        MCP_CLIENTS[id].detectPaths(ctx).map(pathExists)
      );
      return found.some(Boolean) ? id : undefined;
    })
  );
  return detected.filter((id): id is McpClientId => id !== undefined);
}
