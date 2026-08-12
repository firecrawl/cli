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
import { getApiKey, updateConfig } from '../utils/config';
import { browserLogin, isAuthenticated } from '../utils/auth';
import { saveCredentials } from '../utils/credentials';
import {
  buildSkillsInstallArgs,
  BUILD_SKILL_SELECTION,
  BUILD_SKILLS,
  CATALOG_REPO,
  cleanNpmEnv,
  CLI_SKILL_SELECTION,
  CLI_SKILLS,
  SKILL_REPOS,
  WORKFLOW_SKILL_SELECTION,
  WORKFLOW_SKILLS,
  type SkillSelection,
} from './skills-install';
import { hasNpx, installSkillsNative } from './skills-native';
import {
  configureWebDefaults,
  WEB_AGENTS,
  type WebAgent,
} from '../utils/web-defaults';
import {
  ALL_MCP_LAUNCHER_IDS,
  ALL_MCP_TARGET_IDS,
  detectMcpClients,
  detectMcpLaunchers,
  isMcpLauncherId,
  mcpTargetName,
  resolveMcpClientId,
  type McpAuthMode,
  type McpContext,
  type McpLauncherId,
  type McpScope,
  type McpTargetId,
} from '../utils/mcp-clients';
import { setupMcpClient, type McpClientResult } from '../utils/mcp-install';

export type SetupSubcommand =
  | 'skills'
  | 'core'
  | 'build'
  | 'workflows'
  | 'mcp'
  | 'defaults';

type SetupIntegration = SetupSubcommand;

type ResolvedMcpAgent =
  | { kind: 'clients'; ids?: McpTargetId[] }
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
  /** If no API key is found after installing skills, log in via browser. */
  browser?: boolean;
  /** Internal: bundle flow defers the auth offer until every step ran. */
  skipAuthOffer?: boolean;
  /** Agents chosen by flag (`--claude`, `--cursor`, ...); skips the picker. */
  clients?: McpTargetId[];
  /** Force the Firecrawl web rules on or off instead of prompting. */
  rules?: boolean;
}

const green = '\x1b[32m';
const red = '\x1b[31m';
const bold = '\x1b[1m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';
const ENV_API_KEY = 'FIRECRAWL_API_KEY';

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

function isEnvironmentBackedApiKey(
  apiKey: string | undefined,
  runtimeEnv: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(apiKey && runtimeEnv[ENV_API_KEY] === apiKey);
}

function assertSubprocessSafeCredential(
  apiKey?: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env
): void {
  if (apiKey && !isEnvironmentBackedApiKey(apiKey, runtimeEnv)) {
    throw new Error(
      'Secure MCP setup cannot persist a stored API key for future client sessions. Export FIRECRAWL_API_KEY, launch the client through "firecrawl launch <agent>", or configure keyless MCP.'
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
  apiKey?: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> | undefined {
  if (!apiKey) return undefined;

  // Keep this helper safe in isolation. Callers currently reject stored keys
  // before reaching it, but a future call site must not turn one into a raw
  // Authorization header in argv or a client configuration file.
  assertSubprocessSafeCredential(apiKey, runtimeEnv);
  const environmentHeader = environmentHeaderForAgent(agent);
  if (environmentHeader) return { Authorization: environmentHeader };
  throw new Error(
    'This MCP client does not have a verified environment-variable syntax. Choose a supported --agent, use --agent all, or configure the client manually so FIRECRAWL_API_KEY is not persisted as a literal.'
  );
}

function resolveMcpAgent(agent: string | undefined): ResolvedMcpAgent {
  if (!agent) return { kind: 'clients' };

  const normalized = agent.trim().toLowerCase();
  switch (normalized) {
    case '*':
    case 'all':
    case 'launchers':
    case 'launcher':
      return { kind: 'all-launchers' };
    case 'hermes':
    case 'hermes-agent':
      return { kind: 'hermes' };
    case 'openclaw':
      return { kind: 'openclaw' };
    default: {
      const id = resolveMcpClientId(normalized);
      if (!id) {
        throw new Error(
          `Unknown agent "${agent}" for setup mcp. Use one of: ${ALL_MCP_TARGET_IDS.join(', ')}, all.`
        );
      }
      return { kind: 'clients', ids: [id] };
    }
  }
}

/**
 * Main setup command handler
 */
export async function handleSetupCommand(
  subcommand?: SetupSubcommand | (string & {}),
  options: SetupOptions = {}
): Promise<void> {
  if (!subcommand) {
    await handleSetupBundle(options);
    return;
  }

  switch (subcommand) {
    // `skills` is the historical name for the core set; keep it as an alias.
    case 'skills':
    case 'core':
      await installSkills(options, [CLI_SKILL_SELECTION]);
      await offerSkillsAuth(options);
      break;
    case 'build':
      await installSkills(options, [BUILD_SKILL_SELECTION]);
      await offerSkillsAuth(options);
      break;
    case 'workflows':
      await installSkills(options, [WORKFLOW_SKILL_SELECTION]);
      await offerSkillsAuth(options);
      break;
    case 'mcp':
      await installMcp(options);
      break;
    case 'defaults':
      await handleMakeDefaultCommand(options);
      break;
    default: {
      const skill = resolveCatalogSkill(subcommand);
      if (skill) {
        await installSkills(options, [
          { repo: CATALOG_REPO, skills: [skill], label: `${skill} skill` },
        ]);
        await offerSkillsAuth(options);
        break;
      }
      console.error(`Unknown setup subcommand or skill: ${subcommand}`);
      console.log('\nAvailable subcommands:');
      console.log(
        '  core       Install core Firecrawl skills (scrape, search, crawl, interact, indexes); "skills" is an alias'
      );
      console.log(
        '  build      Install Firecrawl build skills for integrating the API into app code'
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
      console.log(
        '  <skill>    Install one catalog skill by name; the "firecrawl-" prefix is optional (e.g. "developer-index", "seo-audit")'
      );
      process.exit(1);
    }
  }
}

/**
 * After installing skills, make sure the user can actually run them: the
 * skills shell out to this CLI, which needs an API key. Never block
 * automation on a login — the browser flow runs only when `--browser` asks
 * for it or an interactive user says yes; otherwise print a one-line hint.
 * Users already authenticated via FIRECRAWL_API_KEY or stored credentials
 * (e.g. from an earlier init or MCP setup) skip all of this silently.
 */
async function offerSkillsAuth(options: SetupOptions): Promise<void> {
  if (options.skipAuthOffer) return;

  if (isAuthenticated()) return;

  let login = options.browser ?? false;
  if (!login && !options.yes && process.stdin.isTTY) {
    const { confirm } = await import('@inquirer/prompts');
    login = await confirm({
      message:
        'No Firecrawl API key found. Log in now so the skills work right away?',
      default: true,
    });
  }

  if (!login) {
    console.log(
      `${dim}No Firecrawl API key found. Skills walk agents through setup on first use; to be ready now, run "firecrawl login" or export FIRECRAWL_API_KEY.${reset}`
    );
    return;
  }

  try {
    const result = await browserLogin();
    saveCredentials({ apiKey: result.apiKey, apiUrl: result.apiUrl });
    updateConfig({ apiKey: result.apiKey, apiUrl: result.apiUrl });
    const teamSuffix = result.teamName ? ` (Team: ${result.teamName})` : '';
    console.log(`${green}✓${reset} Authenticated${teamSuffix}`);
  } catch (error) {
    console.error(
      'Authentication failed:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    console.log(
      `${dim}You can authenticate later with: firecrawl login${reset}`
    );
  }
}

/** Every installable skill across the three catalog families. */
const ALL_CATALOG_SKILLS: readonly string[] = [
  ...CLI_SKILLS,
  ...BUILD_SKILLS,
  ...WORKFLOW_SKILLS,
];

/**
 * Resolve a `setup` argument to a catalog skill name. Accepts the exact name
 * or a bare name without the `firecrawl-` prefix. Group subcommands are
 * matched before this runs, so `build` means the group while `firecrawl-build`
 * still reaches the skill.
 */
function resolveCatalogSkill(name: string): string | undefined {
  if (ALL_CATALOG_SKILLS.includes(name)) return name;
  const prefixed = `firecrawl-${name}`;
  if (ALL_CATALOG_SKILLS.includes(prefixed)) return prefixed;
  return undefined;
}

async function handleSetupBundle(options: SetupOptions): Promise<void> {
  let integrations: SetupIntegration[];

  if (options.yes) {
    integrations = ['skills', 'mcp'];
  } else if (process.stdin.isTTY) {
    integrations = await pickSetupIntegrations();
  } else {
    throw new Error(
      'Setup subcommand is required in non-interactive mode. Use `firecrawl setup --yes` to install skills and MCP, or choose one of: core, build, workflows, mcp, defaults.'
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
  const skillIntegrations: SetupIntegration[] = ['skills', 'workflows'];
  for (const integration of integrations) {
    // Offer auth once after the whole bundle instead of per step.
    await handleSetupCommand(integration, {
      ...bundleOptions,
      skipAuthOffer: true,
    });
  }
  if (integrations.some((i) => skillIntegrations.includes(i))) {
    await offerSkillsAuth(bundleOptions);
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
  selections: readonly SkillSelection[]
): Promise<void> {
  for (const selection of selections) {
    const { repo } = selection;
    if (options.nativeSkills) {
      try {
        const result = await installSkillsNative(repo, {
          agent: options.agent,
          quiet: options.quiet,
          skills: selection.skills,
        });
        if (options.quiet) {
          console.log(
            `  ${green}✓${reset} ${selection.label} ${dim}(${result.skillCount})${reset}`
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
        skills: selection.skills,
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
      await installSkillsNative(repo, { skills: selection.skills });
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
  // Legacy whole-repo path (used by `firecrawl launch`): install each repo
  // in full, labeled by repo name.
  await installSkills(
    { ...options, agent, global: options.global ?? true },
    repos.map((repo) => ({ repo, label: skillRepoLabel(repo) }))
  );
}

export async function installMcp(
  options: SetupOptions,
  // `firecrawl launch` may provide the exact environment inherited by the
  // client it starts. This lets MCP config keep an indirect env reference
  // without mutating the parent shell or exposing the key to setup commands.
  runtimeEnv: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (options.global && options.project) {
    throw new Error('Choose either --global or --project, not both.');
  }

  const apiKey = options.keyless ? undefined : getApiKey();
  const resolvedAgent = resolveMcpAgent(options.agent);

  if (resolvedAgent.kind === 'hermes') {
    await installHermesMcp(runtimeEnv, options.keyless);
    return;
  }
  if (resolvedAgent.kind === 'openclaw') {
    // Hands the credential to a subprocess, so a stored key is not usable.
    assertSubprocessSafeCredential(apiKey, runtimeEnv);
    await installOpenClawMcp(runtimeEnv, options.keyless);
    return;
  }
  if (resolvedAgent.kind === 'all-launchers') {
    // Fails closed before touching anything: this path reaches launchers that
    // hand the credential to a subprocess.
    assertSubprocessSafeCredential(apiKey, runtimeEnv);
    await installMcpClients({ ...options, yes: true }, runtimeEnv, undefined, {
      includeAllLaunchers: true,
    });
    return;
  }

  await installMcpClients(options, runtimeEnv, resolvedAgent.ids);
}

/** Shorten a path for display: relative inside the project, `~` under home. */
function displayPath(target: string, ctx: McpContext): string {
  const relative = path.relative(ctx.cwd, target);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  if (target === ctx.home) return '~';
  return target.startsWith(ctx.home + path.sep)
    ? path.join('~', path.relative(ctx.home, target))
    : target;
}

async function pickMcpClients(
  detected: readonly McpTargetId[]
): Promise<McpTargetId[]> {
  const { checkbox } = await import('@inquirer/prompts');
  return checkbox<McpTargetId>({
    message: 'Which agents do you want to set up?',
    loop: false,
    // Show every agent at once; the default page size would scroll the last
    // ones out of view.
    pageSize: ALL_MCP_TARGET_IDS.length,
    choices: ALL_MCP_TARGET_IDS.map((id) => ({
      name: mcpTargetName(id),
      value: id,
      checked: detected.includes(id),
    })),
  });
}

/**
 * Launchers own their MCP configuration, so they are installed through their
 * own routine instead of a config write. Failures stay scoped to the one
 * launcher: a missing binary must not cost the user the agents that worked.
 */
async function setupMcpLauncher(
  id: McpLauncherId,
  ctx: McpContext,
  runtimeEnv: NodeJS.ProcessEnv
): Promise<McpClientResult> {
  const keyless = ctx.auth !== 'env';
  const result: McpClientResult = {
    id,
    name: mcpTargetName(id),
    mcpStatus: 'failed',
    mcpDetail: '',
    auth: keyless ? 'keyless' : 'env',
    ruleStatus: 'unsupported',
    ruleDetail: '',
  };

  try {
    if (id === 'hermes') {
      await installHermesMcp(runtimeEnv, keyless, true);
      result.mcpDetail = path.join(ctx.home, '.hermes', 'config.yaml');
    } else {
      await installOpenClawMcp(runtimeEnv, keyless, true);
      result.mcpDetail = 'via the openclaw CLI';
    }
    result.mcpStatus = 'configured';
  } catch (error) {
    result.mcpDetail = error instanceof Error ? error.message : String(error);
  }
  return result;
}

async function confirmMcpRules(): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts');
  return confirm({
    message:
      'Add rules so agents prefer Firecrawl for web search and scraping?',
    default: true,
  });
}

async function installMcpClients(
  options: SetupOptions,
  runtimeEnv: NodeJS.ProcessEnv,
  explicitIds?: McpTargetId[],
  { includeAllLaunchers = false } = {}
): Promise<void> {
  const apiKey = options.keyless ? undefined : getApiKey();
  // A stored key cannot be written into agent config, so authenticated setup
  // requires the variable to be exported where the agent will read it.
  const auth: McpAuthMode = isEnvironmentBackedApiKey(apiKey, runtimeEnv)
    ? 'env'
    : 'keyless';

  const ctx: McpContext = {
    // Resolved so path comparisons hold even for an unnormalized HOME.
    home: path.resolve(os.homedir()),
    cwd: path.resolve(process.cwd()),
    platform: process.platform,
    env: runtimeEnv,
    auth,
  };
  const scope: McpScope = options.project ? 'project' : 'global';
  // Prompts only make sense when someone is there to answer them.
  const nonInteractive = Boolean(options.yes) || !process.stdin.isTTY;

  let selected = explicitIds ?? options.clients;
  if (!selected || selected.length === 0) {
    const detected: McpTargetId[] = [
      ...(await detectMcpClients(ctx)),
      ...detectMcpLaunchers(ctx),
    ];
    if (nonInteractive) {
      if (detected.length === 0 && !includeAllLaunchers) {
        throw new Error(
          'No coding agents detected. Pass an agent flag such as --claude or --cursor.'
        );
      }
      selected = detected;
    } else {
      selected = await pickMcpClients(detected);
      if (selected.length === 0) {
        console.log('No agents selected. Nothing changed.');
        return;
      }
    }
  }

  // `--agent all` reaches every launch integration whether or not it looks
  // installed, which is what the flag has always meant.
  if (includeAllLaunchers) {
    selected = [
      ...selected.filter((id) => !isMcpLauncherId(id)),
      ...ALL_MCP_LAUNCHER_IDS,
    ];
  }

  // `-y` stays MCP-only so automation never rewrites instruction files by
  // surprise; the flags are there when a script does want the rules.
  const rules =
    options.rules ?? (nonInteractive ? false : await confirmMcpRules());

  const results: McpClientResult[] = [];
  for (const id of selected) {
    results.push(
      isMcpLauncherId(id)
        ? await setupMcpLauncher(id, ctx, runtimeEnv)
        : await setupMcpClient(id, { scope, rules, ctx })
    );
  }

  reportMcpResults(results, ctx, options, Boolean(apiKey));
}

function ruleLine(
  result: McpClientResult,
  ctx: McpContext
): string | undefined {
  switch (result.ruleStatus) {
    case 'installed':
    case 'updated':
      return `  Rules ${result.ruleStatus} ${dim}${displayPath(result.ruleDetail, ctx)}${reset}`;
    case 'skipped':
      return '  Rules skipped';
    case 'unsupported':
      return `  Rules ${dim}not supported by this agent${reset}`;
    case 'failed':
      return `  ${red}Rules failed${reset} ${result.ruleDetail}`;
  }
}

/**
 * Explain any gap between the credential the user has and what actually got
 * written, so a keyless fallback is never silent.
 */
function authNotes(
  results: McpClientResult[],
  ctx: McpContext,
  hasApiKey: boolean
): string[] {
  const succeeded = results.filter((result) => result.mcpStatus !== 'failed');
  if (succeeded.length === 0) return [];

  if (!hasApiKey) {
    return [
      'Running keyless (search, scrape, parse). Run "firecrawl login" and rerun to unlock the full tool surface.',
    ];
  }

  if (ctx.auth !== 'env') {
    return [
      `Configured keyless: your stored key is never written into agent config. Export ${ENV_API_KEY} where your agents run, then rerun to authenticate.`,
    ];
  }

  return [];
}

function reportMcpResults(
  results: McpClientResult[],
  ctx: McpContext,
  options: SetupOptions,
  hasApiKey: boolean
): void {
  const succeeded = results.filter((result) => result.mcpStatus !== 'failed');

  if (options.quiet) {
    for (const result of results) {
      console.log(
        result.mcpStatus === 'failed'
          ? `  ${red}✗${reset} Firecrawl MCP failed for ${result.name}: ${result.mcpDetail}`
          : `  ${green}✓${reset} Firecrawl MCP configured for ${result.name}`
      );
    }
    return;
  }

  for (const result of results) {
    console.log(`${bold}${result.name}${reset}`);
    console.log(
      result.mcpStatus === 'failed'
        ? `  ${red}MCP failed${reset} ${result.mcpDetail}`
        : `  MCP ${result.mcpStatus} ${dim}${displayPath(result.mcpDetail, ctx)}${reset}`
    );
    const rules = ruleLine(result, ctx);
    if (rules) console.log(rules);
  }

  console.log('');
  console.log(
    `Firecrawl MCP set up for ${succeeded.length}/${results.length} agents. Restart your agents to load it.`
  );
  for (const note of authNotes(results, ctx, hasApiKey)) {
    console.log(`${dim}${note}${reset}`);
  }

  if (succeeded.length === 0) {
    throw new Error('Failed to configure Firecrawl MCP.');
  }
}

function firecrawlMcpConfig(
  agent?: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  keyless = false
): {
  url: string;
  headers?: Record<string, string>;
  transport?: string;
} {
  return {
    url: firecrawlHostedMcpUrl(),
    headers: firecrawlMcpHeaders(
      agent,
      keyless ? undefined : getApiKey(),
      runtimeEnv
    ),
  };
}

export async function installHermesMcp(
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  keyless = false,
  /** Suppress standalone logging when a caller renders its own summary. */
  quiet = false
): Promise<void> {
  const config = firecrawlMcpConfig('hermes', runtimeEnv, keyless);
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
  if (!quiet) console.log(`Hermes Agent MCP configured at ${configPath}.`);
}

export async function installOpenClawMcp(
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  keyless = false,
  /** Suppress standalone logging when a caller renders its own summary. */
  quiet = false
): Promise<void> {
  const config = {
    ...firecrawlMcpConfig('openclaw', runtimeEnv, keyless),
    transport: 'streamable-http',
  };
  if (!quiet) console.log('Configuring Firecrawl MCP for OpenClaw...\n');

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
