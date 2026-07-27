/**
 * Setup command implementation
 * Installs firecrawl skill files and MCP server into AI coding agents
 */

import { execFileSync, execSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getApiKey } from '../utils/config';
import {
  buildSkillsInstallArgs,
  cleanNpmEnv,
  SKILL_REPOS,
  WORKFLOW_SKILL_REPOS,
} from './skills-install';
import { hasNpx, installSkillsNative } from './skills-native';
import {
  configureWebDefaults,
  WEB_AGENTS,
  type WebAgent,
} from '../utils/web-defaults';

export type SetupSubcommand = 'skills' | 'workflows' | 'mcp' | 'defaults';

type SetupIntegration = SetupSubcommand;

type ResolvedMcpAgent =
  | { kind: 'add-mcp'; agent?: string; all?: boolean }
  | { kind: 'hermes' }
  | { kind: 'openclaw' }
  | { kind: 'all-launchers' };

export interface SetupOptions {
  global?: boolean;
  /** Explicitly install MCP into project scope. */
  project?: boolean;
  agent?: string;
  undo?: boolean;
  /** Skip the interactive harness picker and apply to all agents. */
  yes?: boolean;
  /** Use the built-in skill installer instead of shelling out to npx skills. */
  nativeSkills?: boolean;
  /** Render compact skill install output. */
  quiet?: boolean;
  /** Configure the anonymous hosted MCP path even when a stored key exists. */
  keyless?: boolean;
}

const green = '\x1b[32m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';
const ADD_MCP_PACKAGE = 'add-mcp@1.14.0';
const ENV_API_KEY = 'FIRECRAWL_API_KEY';
const ADD_MCP_LAUNCH_AGENTS = [
  'claude-code',
  'vscode',
  'codex',
  'opencode',
  'cursor',
] as const;

const SKILL_REPO_LABELS: Record<string, string> = {
  'firecrawl/cli': 'Core CLI skills',
  'firecrawl/skills': 'Build skills',
  'firecrawl/firecrawl-workflows': 'Workflow skills',
};

function skillRepoLabel(repo: string): string {
  return SKILL_REPO_LABELS[repo] ?? repo;
}

const CMD_META_CHARS = /([()%!^"<>&|])/g;

function rejectCommandControlCharacters(value: string, label: string): void {
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} contains an unsupported control character.`);
  }
}

/** Quote one argv value for cmd.exe using the same two-layer escaping model as
 * established Windows spawn libraries: first the C runtime, then cmd.exe. */
function escapeCmdArg(arg: string): string {
  rejectCommandControlCharacters(arg, 'Command argument');
  const quoted = `"${arg
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META_CHARS, '^$1');
}

function windowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const configured = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return configured
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);
}

/** Resolve the actual Windows launcher instead of assuming every tool is a
 * `.cmd` shim. Native `.exe` clients must bypass cmd.exe entirely. */
function resolveWindowsCommand(
  command: string,
  env: NodeJS.ProcessEnv
): string {
  rejectCommandControlCharacters(command, 'Command');
  const hasPath = /[\\/]/.test(command);
  const hasExtension = path.extname(command) !== '';
  const candidates = hasExtension
    ? [command]
    : windowsPathExtensions(env).map((extension) => `${command}${extension}`);
  const pathEntries = hasPath
    ? ['']
    : (env.PATH ?? env.Path ?? env.path ?? '')
        .split(path.delimiter)
        .map((entry) => entry.replace(/^"|"$/g, ''))
        .filter(Boolean);

  for (const directory of pathEntries) {
    for (const candidate of candidates) {
      const resolved = directory ? path.join(directory, candidate) : candidate;
      if (existsSync(resolved)) return resolved;
    }
  }

  // Let CreateProcess perform its normal resolution for native executables.
  // Crucially, do not silently rewrite an unknown command to `<name>.cmd`.
  return command;
}

/**
 * Cross-platform, injection-safe replacement for `execFileSync`.
 *
 * On win32, external tools ship as `.cmd`/`.bat` shims (npx.cmd, npm.cmd,
 * codex.cmd, openclaw.cmd). Node's `execFile`/`execFileSync` calls CreateProcess
 * directly and CANNOT launch a `.cmd`/`.bat` file — it throws ENOENT/EINVAL. The
 * only reliable way is to route through the shell (cmd.exe). To keep the argv
 * safety this file relies on (secrets must never be shell-interpreted), we
 * escape every argument for cmd.exe ourselves instead of letting the shell
 * re-split a joined string.
 *
 * On every other platform we spawn the binary directly with no shell, exactly as
 * `execFileSync` did before.
 */
function runClientCommand(
  command: string,
  args: string[],
  options: Parameters<typeof execFileSync>[2]
): void {
  rejectCommandControlCharacters(command, 'Command');
  for (const arg of args)
    rejectCommandControlCharacters(arg, 'Command argument');

  if (process.platform !== 'win32') {
    execFileSync(command, args, options);
    return;
  }

  const env = options?.env ?? process.env;
  const resolved = resolveWindowsCommand(command, env);
  if (!/\.(?:cmd|bat)$/i.test(resolved)) {
    execFileSync(resolved, args, options);
    return;
  }

  const line = [escapeCmdArg(resolved), ...args.map(escapeCmdArg)].join(' ');
  const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  const windowsOptions = {
    ...options,
    windowsVerbatimArguments: true,
  } as Parameters<typeof execFileSync>[2];
  execFileSync(comspec, ['/d', '/s', '/c', `"${line}"`], windowsOptions);
}

function firecrawlHostedMcpUrl(): string {
  return 'https://mcp.firecrawl.dev/v2/mcp';
}

function isEnvironmentBackedApiKey(apiKey: string | undefined): boolean {
  return Boolean(apiKey && process.env[ENV_API_KEY] === apiKey);
}

function assertSubprocessSafeCredential(apiKey?: string): void {
  if (apiKey && !isEnvironmentBackedApiKey(apiKey)) {
    throw new Error(
      'Secure MCP setup cannot pass a stored API key to this client. Export FIRECRAWL_API_KEY and rerun with a supported --agent, or run keyless setup without a credential.'
    );
  }
}

function environmentHeaderForAgent(agent?: string): string | undefined {
  switch (agent) {
    case 'claude-code':
    case 'hermes':
    case 'openclaw':
      return `Bearer \${${ENV_API_KEY}}`;
    case 'cursor':
    case 'vscode':
      return `Bearer \${env:${ENV_API_KEY}}`;
    case 'opencode':
      return `Bearer {env:${ENV_API_KEY}}`;
    default:
      return undefined;
  }
}

function firecrawlMcpHeaders(
  agent?: string,
  apiKey?: string
): Record<string, string> | undefined {
  if (!apiKey) return undefined;

  // Keep this helper safe in isolation. Callers currently reject stored keys
  // before reaching it, but a future call site must not turn one into a raw
  // Authorization header in argv or a client configuration file.
  assertSubprocessSafeCredential(apiKey);
  const environmentHeader = environmentHeaderForAgent(agent);
  if (environmentHeader) return { Authorization: environmentHeader };
  throw new Error(
    'This MCP client does not have a verified environment-variable syntax. Choose a supported --agent, use --agent all, or configure the client manually so FIRECRAWL_API_KEY is not persisted as a literal.'
  );
}

function resolveMcpAgent(agent: string | undefined): ResolvedMcpAgent {
  if (!agent) return { kind: 'add-mcp' };

  const normalized = agent.trim().toLowerCase();
  switch (normalized) {
    case '*':
    case 'all':
    case 'launchers':
    case 'launcher':
      return { kind: 'all-launchers' };
    case 'claude':
    case 'claude-code':
      return { kind: 'add-mcp', agent: 'claude-code' };
    case 'code':
    case 'vscode':
    case 'vs-code':
      return { kind: 'add-mcp', agent: 'vscode' };
    case 'codex':
    case 'codex-app':
    case 'codex-desktop':
    case 'codex-gui':
      return { kind: 'add-mcp', agent: 'codex' };
    case 'opencode':
    case 'open-code':
      return { kind: 'add-mcp', agent: 'opencode' };
    case 'hermes':
    case 'hermes-agent':
      return { kind: 'hermes' };
    case 'openclaw':
      return { kind: 'openclaw' };
    default:
      return { kind: 'add-mcp', agent };
  }
}

/**
 * Main setup command handler
 */
export async function handleSetupCommand(
  subcommand?: SetupSubcommand,
  options: SetupOptions = {}
): Promise<void> {
  if (!subcommand) {
    await handleSetupBundle(options);
    return;
  }

  switch (subcommand) {
    case 'skills':
      await installSkills(options, SKILL_REPOS);
      break;
    case 'workflows':
      await installSkills(options, WORKFLOW_SKILL_REPOS);
      break;
    case 'mcp':
      await installMcp(options);
      break;
    case 'defaults':
      await handleMakeDefaultCommand(options);
      break;
    default:
      console.error(`Unknown setup subcommand: ${subcommand}`);
      console.log('\nAvailable subcommands:');
      console.log(
        '  skills     Install core/build Firecrawl skills into AI coding agents'
      );
      console.log(
        '  workflows  Install Firecrawl workflow skills into AI coding agents'
      );
      console.log(
        '  mcp        Install firecrawl MCP server into editors (Cursor, Claude Code, VS Code, etc.)'
      );
      console.log(
        '  defaults   Make Firecrawl the default web provider (use --undo to restore native web tools)'
      );
      process.exit(1);
  }
}

async function handleSetupBundle(options: SetupOptions): Promise<void> {
  let integrations: SetupIntegration[];

  if (options.yes) {
    integrations = ['skills', 'mcp'];
  } else if (process.stdin.isTTY) {
    integrations = await pickSetupIntegrations();
  } else {
    throw new Error(
      'Setup subcommand is required in non-interactive mode. Use `firecrawl setup --yes` to install skills and MCP, or choose one of: skills, workflows, mcp, defaults.'
    );
  }

  if (integrations.length === 0) {
    console.log('No integrations selected. Nothing changed.');
    return;
  }

  const bundleOptions = {
    ...options,
    global: options.project ? undefined : (options.global ?? true),
  };
  for (const integration of integrations) {
    await handleSetupCommand(integration, bundleOptions);
  }
}

async function pickSetupIntegrations(): Promise<SetupIntegration[]> {
  const { checkbox } = await import('@inquirer/prompts');
  return checkbox<SetupIntegration>({
    message: 'What should Firecrawl set up?',
    choices: [
      {
        name: 'Skills — install Firecrawl skills for AI coding agents',
        value: 'skills',
        checked: true,
      },
      {
        name: 'MCP — install Firecrawl MCP server',
        value: 'mcp',
        checked: true,
      },
      {
        name: 'Workflows — install Firecrawl workflow skills',
        value: 'workflows',
      },
      {
        name: 'Defaults — make Firecrawl the default web provider',
        value: 'defaults',
      },
    ],
  });
}

/** Map a user-supplied --agent value to a known web agent. */
function resolveWebAgent(agent: string): WebAgent | null {
  const normalized = agent.trim().toLowerCase();
  if (normalized === 'claude' || normalized === 'claude code') {
    return 'Claude Code';
  }
  if (normalized === 'codex') return 'Codex';
  return null;
}

function promptInput(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Interactively ask which harnesses to apply the change to, one by one.
 * Returns the selected agents, or null if the user aborted.
 */
async function pickWebAgents(undo: boolean): Promise<WebAgent[] | null> {
  const verb = undo
    ? 'Re-enable native web tools for'
    : 'Disable native web tools for';
  console.log(
    undo
      ? 'Choose which harnesses to restore native web tools for:'
      : 'Choose which harnesses to route through Firecrawl:'
  );
  console.log('');

  const selected: WebAgent[] = [];
  for (const agent of WEB_AGENTS) {
    const answer = (
      await promptInput(`  ${verb} ${agent}? [Y/n] `)
    ).toLowerCase();
    if (answer === '' || answer === 'y' || answer === 'yes') {
      selected.push(agent);
    }
  }
  console.log('');
  return selected;
}

export async function handleMakeDefaultCommand(
  options: SetupOptions = {}
): Promise<void> {
  const undo = Boolean(options.undo);
  let agents: readonly WebAgent[] | undefined;

  if (options.agent) {
    const resolved = resolveWebAgent(options.agent);
    if (!resolved) {
      console.error(
        `Unknown agent "${options.agent}" for setup defaults. Use "claude" or "codex".`
      );
      process.exit(1);
    }
    agents = [resolved];
  } else if (!options.yes && process.stdin.isTTY) {
    const picked = await pickWebAgents(undo);
    if (!picked || picked.length === 0) {
      console.log('No harnesses selected. Nothing changed.');
      return;
    }
    agents = picked;
  }

  const results = await configureWebDefaults({ undo, agents });

  for (const result of results) {
    const prefix = result.skipped ? '!' : result.changed ? '✓' : '•';
    console.log(`${prefix} ${result.message}`);
    console.log(`  ${result.path}`);
  }

  console.log('');
  if (undo) {
    console.log('Native web tools restored where supported.');
  } else {
    console.log(
      'Firecrawl is now the default web provider for supported AI agents.'
    );
  }
}

async function installSkills(
  options: SetupOptions,
  repos: readonly string[]
): Promise<void> {
  for (const repo of repos) {
    if (options.nativeSkills) {
      try {
        const result = await installSkillsNative(repo, {
          agent: options.agent,
          quiet: options.quiet,
        });
        if (options.quiet) {
          console.log(
            `  ${green}✓${reset} ${skillRepoLabel(repo)} ${dim}(${result.skillCount})${reset}`
          );
        }
      } catch (error) {
        console.error(
          `Failed to install skills from ${repo}:`,
          error instanceof Error ? error.message : 'Unknown error'
        );
        process.exit(1);
      }
      continue;
    }

    if (hasNpx()) {
      const args = buildSkillsInstallArgs({
        repo,
        agent: options.agent,
        global: true,
        yes: options.yes,
        includeNpxYes: true,
      });

      const cmd = args.join(' ');
      console.log(`Running: ${cmd}\n`);

      try {
        execSync(cmd, { stdio: 'inherit', env: cleanNpmEnv() });
        continue;
      } catch {
        process.exit(1);
      }
    }

    // Fallback: native install (no npx/Node required)
    try {
      await installSkillsNative(repo);
    } catch (error) {
      console.error(
        `Failed to install skills from ${repo}:`,
        error instanceof Error ? error.message : 'Unknown error'
      );
      process.exit(1);
    }
  }
}

export async function installSkillsForAgent(
  agent: string,
  options: SetupOptions = {},
  repos: readonly string[] = SKILL_REPOS
): Promise<void> {
  await installSkills(
    { ...options, agent, global: options.global ?? true },
    repos
  );
}

export async function installMcp(options: SetupOptions): Promise<void> {
  if (options.global && options.project) {
    throw new Error('Choose either --global or --project, not both.');
  }

  const apiKey = options.keyless ? undefined : getApiKey();
  const resolvedAgent = resolveMcpAgent(options.agent);
  if (resolvedAgent.kind === 'all-launchers' && options.project && apiKey) {
    throw new Error(
      'Authenticated --agent all setup does not support --project because Codex requires a global environment-backed MCP configuration. Choose one --agent for project setup, use --agent all --global, or run keyless setup.'
    );
  }
  if (!options.agent && isEnvironmentBackedApiKey(apiKey)) {
    throw new Error(
      "Environment-backed MCP setup requires --agent so Firecrawl can use that client's native variable syntax. Choose a supported client or use --agent all; the API key will not be written literally."
    );
  }
  if (resolvedAgent.kind === 'hermes') {
    await installHermesMcp();
    return;
  }
  assertSubprocessSafeCredential(apiKey);
  if (resolvedAgent.kind === 'openclaw') {
    await installOpenClawMcp();
    return;
  }
  if (resolvedAgent.kind === 'all-launchers') {
    await installAllMcpLaunchers(options);
    return;
  }

  await installAddMcp(options, resolvedAgent);
}

async function installAllMcpLaunchers(options: SetupOptions): Promise<void> {
  for (const agent of ADD_MCP_LAUNCH_AGENTS) {
    await installAddMcp({ ...options, yes: true }, { kind: 'add-mcp', agent });
  }
  await installHermesMcp();
  await installOpenClawMcp();
}

async function installAddMcp(
  options: SetupOptions,
  resolvedAgent: Extract<ResolvedMcpAgent, { kind: 'add-mcp' }>
): Promise<void> {
  const mcpUrl = firecrawlHostedMcpUrl();
  const apiKey = options.keyless ? undefined : getApiKey();
  if (
    resolvedAgent.agent === 'codex' &&
    !options.project &&
    apiKey &&
    isEnvironmentBackedApiKey(apiKey)
  ) {
    installCodexMcpFromEnvironment(options, mcpUrl);
    return;
  }

  const headers = firecrawlMcpHeaders(resolvedAgent.agent, apiKey);
  const useGlobal = !options.project && Boolean(options.global);

  const args = [
    '-y',
    ADD_MCP_PACKAGE,
    mcpUrl,
    '--name',
    'firecrawl',
    '--transport',
    'http',
  ];

  if (headers?.Authorization) {
    args.push('--header', `Authorization: ${headers.Authorization}`);
  }

  if (useGlobal) {
    args.push('--global');
  }

  if (resolvedAgent.agent) {
    args.push('--agent', resolvedAgent.agent);
  } else if (resolvedAgent.all) {
    args.push('--all');
  }

  if (options.yes) {
    args.push('--yes');
  }

  if (!options.quiet) {
    console.log('Configuring Firecrawl MCP...\n');
  }

  try {
    runClientCommand('npx', args, {
      stdio: 'inherit',
      env: cleanNpmEnv(),
    });
    if (options.quiet) {
      const target = resolvedAgent.agent
        ? ` for ${resolvedAgent.agent}`
        : resolvedAgent.all
          ? ' for launch integrations'
          : '';
      console.log(`  ${green}✓${reset} Firecrawl MCP configured${target}`);
    }
  } catch {
    throw new Error('Failed to configure Firecrawl MCP.');
  }
}

function installCodexMcpFromEnvironment(
  options: SetupOptions,
  mcpUrl: string
): void {
  if (!options.quiet) {
    console.log('Configuring Firecrawl MCP...\n');
  }

  try {
    runClientCommand(
      'codex',
      [
        'mcp',
        'add',
        'firecrawl',
        '--url',
        mcpUrl,
        '--bearer-token-env-var',
        'FIRECRAWL_API_KEY',
      ],
      { stdio: 'inherit', env: cleanNpmEnv() }
    );
    if (options.quiet) {
      console.log(`  ${green}✓${reset} Firecrawl MCP configured for codex`);
    }
  } catch {
    throw new Error('Failed to configure Firecrawl MCP for Codex.');
  }
}

function firecrawlMcpConfig(agent?: string): {
  url: string;
  headers?: Record<string, string>;
  transport?: string;
} {
  return {
    url: firecrawlHostedMcpUrl(),
    headers: firecrawlMcpHeaders(agent, getApiKey()),
  };
}

export async function installHermesMcp(): Promise<void> {
  const config = firecrawlMcpConfig('hermes');
  const configPath = path.join(os.homedir(), '.hermes', 'config.yaml');
  mkdirSync(path.dirname(configPath), { recursive: true });

  const existing = existsSync(configPath)
    ? readFileSync(configPath, 'utf-8')
    : '';
  const root = (parseYaml(existing || '{}') ?? {}) as Record<string, unknown>;
  const mcpServers =
    typeof root.mcp_servers === 'object' &&
    root.mcp_servers !== null &&
    !Array.isArray(root.mcp_servers)
      ? (root.mcp_servers as Record<string, unknown>)
      : {};

  mcpServers.firecrawl = config;
  root.mcp_servers = mcpServers;
  writeFileSync(configPath, stringifyYaml(root), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  if (process.platform !== 'win32') {
    chmodSync(configPath, 0o600);
  }
  console.log(`Hermes Agent MCP configured at ${configPath}.`);
}

export async function installOpenClawMcp(): Promise<void> {
  const config = {
    ...firecrawlMcpConfig('openclaw'),
    transport: 'streamable-http',
  };
  console.log('Configuring Firecrawl MCP for OpenClaw...\n');

  try {
    runClientCommand(
      'openclaw',
      ['mcp', 'set', 'firecrawl', JSON.stringify(config)],
      {
        stdio: 'pipe',
        env: cleanNpmEnv(),
      }
    );
  } catch {
    throw new Error(
      'Failed to configure Firecrawl MCP for OpenClaw. Verify that OpenClaw is installed and available on PATH.'
    );
  }
}
