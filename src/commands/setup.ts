/**
 * Setup command implementation
 * Installs firecrawl skill files and MCP server into AI coding agents
 */

import { execFileSync } from 'child_process';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  stripComments,
  type ParseError,
} from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getApiKey, updateConfig } from '../utils/config';
import { browserLogin, isAuthenticated } from '../utils/auth';
import { promptInput } from '../utils/prompt';
import { saveCredentials } from '../utils/credentials';
import { getCatalogSkills } from '../utils/skill-catalog';
import { rememberSkillInstall } from '../utils/skill-update-notice';
import {
  buildSkillsInstallArgs,
  BUILD_SKILL_SELECTION,
  BUILD_SKILLS,
  CATALOG_REPO,
  cleanNpmEnv,
  resolveSkillSelection,
  CLI_SKILL_SELECTION,
  CLI_SKILLS,
  SKILL_REPOS,
  WORKFLOW_SKILL_SELECTION,
  WORKFLOW_SKILLS,
  type SkillSelection,
} from './skills-install';
import { hasNpx, installSkillsNative } from './skills-native';
import { dim, green, reset } from '../utils/terminal';
import {
  configureWebDefaults,
  WEB_AGENTS,
  type WebAgent,
} from '../utils/web-defaults';

export type SetupSubcommand =
  | 'skills'
  | 'core'
  | 'build'
  | 'workflows'
  | 'mcp'
  | 'defaults';

type SetupIntegration = SetupSubcommand;

type ResolvedMcpAgent =
  | { kind: 'add-mcp'; agent?: string; all?: boolean }
  | { kind: 'config-file'; client: ConfigFileClient }
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
}

const ADD_MCP_PACKAGE = 'add-mcp@1.14.0';
const ENV_API_KEY = 'FIRECRAWL_API_KEY';
const ADD_MCP_LAUNCH_AGENTS: Record<string, string> = {
  'claude-code': 'Claude Code',
  vscode: 'VS Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  'gemini-cli': 'Gemini CLI',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
};

/** Clients whose MCP entry this command writes straight into their user settings. */
const CONFIG_FILE_CLIENTS = {
  amp: 'Amp',
  'grok-build': 'Grok Build',
  zed: 'Zed',
} as const;
type ConfigFileClient = keyof typeof CONFIG_FILE_CLIENTS;

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

/** Quote the program path that cmd.exe itself resolves. Unlike arguments, this
 * token is parsed by cmd.exe, where a caret-escaped ^" is a literal character
 * rather than a quote, so escaping it would split paths such as
 * `C:\Program Files\nodejs\npx.cmd` at the space. Windows paths cannot contain
 * `"`. cmd.exe still expands `%VAR%` (and `!VAR!` under delayed expansion)
 * inside quotes, and a caret is literal there, so each `%`/`!` is placed
 * outside the quotes and caret-escaped: `"C:\a"^%"X"^%"b\npx.cmd"`. */
function quoteCmdCommand(command: string): string {
  rejectCommandControlCharacters(command, 'Command');
  if (command.includes('"')) {
    throw new Error('Command path contains an unsupported quote character.');
  }
  return `"${command.replace(/[%!]/g, '"^$&"')}"`;
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

function isCommandOnPath(command: string): boolean {
  if (process.platform === 'win32') {
    return resolveWindowsCommand(command, process.env) !== command;
  }
  if (!process.env.PATH) return false;
  return process.env.PATH.split(path.delimiter).some((directory) => {
    const candidate = path.join(directory || '.', command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
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
export function runClientCommand(
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

  const line = [quoteCmdCommand(resolved), ...args.map(escapeCmdArg)].join(' ');
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
    case 'amp':
    case 'claude-code':
    case 'gemini-cli':
    case 'grok-build':
    case 'hermes':
    case 'openclaw':
      return `Bearer \${${ENV_API_KEY}}`;
    case 'cursor':
    case 'vscode':
    case 'windsurf':
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
    case 'cursor':
      return { kind: 'add-mcp', agent: 'cursor' };
    case 'gemini':
    case 'gemini-cli':
      return { kind: 'add-mcp', agent: 'gemini-cli' };
    case 'windsurf':
      return { kind: 'add-mcp', agent: 'windsurf' };
    case 'antigravity':
      return { kind: 'add-mcp', agent: 'antigravity' };
    case 'amp':
    case 'ampcode':
    case 'amp-code':
      return { kind: 'config-file', client: 'amp' };
    case 'grok':
    case 'grok-build':
    case 'grok-cli':
      return { kind: 'config-file', client: 'grok-build' };
    case 'zed':
      return { kind: 'config-file', client: 'zed' };
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
      const skill = await resolveCatalogSkill(subcommand);
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
async function resolveCatalogSkill(name: string): Promise<string | undefined> {
  if (ALL_CATALOG_SKILLS.includes(name)) return name;
  const prefixed = `firecrawl-${name}`;
  if (ALL_CATALOG_SKILLS.includes(prefixed)) return prefixed;
  if (!/^firecrawl(?:-[a-z0-9]+)+$/.test(name)) return undefined;
  // Skills published after this release: confirm against the catalog when it is reachable.
  try {
    const catalog = await getCatalogSkills();
    return catalog.some((skill) => skill.name === name) ? name : undefined;
  } catch {
    return name;
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
      await promptInput(
        `  ${verb} ${agent}? [Y/n] `,
        'No answer received. Run "firecrawl setup defaults --agent <name>" or "firecrawl setup defaults --yes" to skip the harness prompts.'
      )
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
          family: selection.family,
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
      const skills = await resolveSkillSelection(selection);
      const args = buildSkillsInstallArgs({
        repo,
        agent: options.agent,
        global: true,
        yes: options.yes,
        includeNpxYes: true,
        skills,
      });

      console.log(`Running: ${args.join(' ')}\n`);

      try {
        runClientCommand(args[0], args.slice(1), {
          stdio: 'inherit',
          env: cleanNpmEnv(),
        });
        await rememberSkillInstall(repo, skills, selection.family);
        continue;
      } catch {
        process.exit(1);
      }
    }

    // Fallback: native install (no npx/Node required)
    try {
      await installSkillsNative(repo, {
        family: selection.family,
        agent: options.agent,
        skills: selection.skills,
      });
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
  if (resolvedAgent.kind === 'all-launchers' && options.project && apiKey) {
    throw new Error(
      'Authenticated --agent all setup does not support --project because Codex requires a global environment-backed MCP configuration. Choose one --agent for project setup, use --agent all --global, or run keyless setup.'
    );
  }
  if (!options.agent && isEnvironmentBackedApiKey(apiKey, runtimeEnv)) {
    throw new Error(
      "Environment-backed MCP setup requires --agent so Firecrawl can use that client's native variable syntax. Choose a supported client or use --agent all; the API key will not be written literally."
    );
  }
  if (resolvedAgent.kind === 'hermes') {
    await installHermesMcp(runtimeEnv, options.keyless);
    return;
  }
  assertSubprocessSafeCredential(apiKey, runtimeEnv);
  if (resolvedAgent.kind === 'openclaw') {
    await installOpenClawMcp(runtimeEnv, options.keyless);
    return;
  }
  if (resolvedAgent.kind === 'all-launchers') {
    await installAllMcpLaunchers(options, runtimeEnv);
    return;
  }
  if (resolvedAgent.kind === 'config-file') {
    if (options.project) {
      throw new Error(
        `Firecrawl configures ${CONFIG_FILE_CLIENTS[resolvedAgent.client]} in its user settings only; rerun without --project.`
      );
    }
    await installConfigFileMcp(
      resolvedAgent.client,
      runtimeEnv,
      options.keyless
    );
    return;
  }

  await installAddMcp(options, resolvedAgent, runtimeEnv);
}

/** Why --agent all cannot configure an add-mcp client, or undefined when it can. */
function addMcpSkipReason(
  agent: string,
  apiKey: string | undefined
): string | undefined {
  if (!apiKey) return undefined;
  if (agent === 'codex') {
    return isCommandOnPath('codex') ? undefined : 'codex not found on PATH';
  }
  if (environmentHeaderForAgent(agent)) return undefined;
  return 'no verified environment-variable syntax for the API key, rerun with --keyless or configure it manually';
}

function configFileSkipReason(
  client: ConfigFileClient,
  apiKey: string | undefined,
  project: boolean | undefined
): string | undefined {
  if (project)
    return 'configured in user settings only, rerun without --project';
  if (!apiKey || environmentHeaderForAgent(client)) return undefined;
  return 'no verified environment-variable syntax for the API key, rerun with --keyless or configure it manually';
}

/**
 * Configure every launch integration. A client that cannot be configured here
 * is skipped and reported; only a failure in a client we attempted is an error.
 */
async function installAllMcpLaunchers(
  options: SetupOptions,
  runtimeEnv: NodeJS.ProcessEnv
): Promise<void> {
  const apiKey = options.keyless ? undefined : getApiKey();
  const clients = [
    ...Object.entries(ADD_MCP_LAUNCH_AGENTS).map(([agent, label]) => ({
      label,
      skipReason: addMcpSkipReason(agent, apiKey),
      install: () =>
        installAddMcp(
          { ...options, yes: true },
          { kind: 'add-mcp', agent },
          runtimeEnv
        ),
    })),
    ...(Object.keys(CONFIG_FILE_CLIENTS) as ConfigFileClient[]).map(
      (client) => ({
        label: CONFIG_FILE_CLIENTS[client],
        skipReason: configFileSkipReason(client, apiKey, options.project),
        install: () =>
          installConfigFileMcp(client, runtimeEnv, options.keyless),
      })
    ),
    {
      label: 'Hermes Agent',
      skipReason: undefined,
      install: () => installHermesMcp(runtimeEnv, options.keyless),
    },
    {
      label: 'OpenClaw',
      skipReason: isCommandOnPath('openclaw')
        ? undefined
        : 'openclaw not found on PATH',
      install: () => installOpenClawMcp(runtimeEnv, options.keyless),
    },
  ];

  const configured: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const client of clients) {
    if (client.skipReason) {
      if (!options.quiet) {
        console.log(`Skipping ${client.label}: ${client.skipReason}.\n`);
      }
      skipped.push(`${client.label} (${client.skipReason})`);
      continue;
    }
    try {
      await client.install();
      configured.push(client.label);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`${client.label}: ${message}\n`);
      failed.push(client.label);
    }
  }

  if (!options.quiet) {
    console.log('Firecrawl MCP setup summary:');
    console.log(
      `  ${green}✓${reset} Configured: ${configured.join(', ') || 'none'}`
    );
    if (skipped.length > 0) {
      console.log(`  ${dim}-${reset} Skipped: ${skipped.join('; ')}`);
    }
    if (failed.length > 0) console.log(`  ✗ Failed: ${failed.join(', ')}`);
  }
  if (failed.length > 0) {
    throw new Error(
      `Failed to configure Firecrawl MCP for ${failed.join(', ')}.`
    );
  }
}

async function installAddMcp(
  options: SetupOptions,
  resolvedAgent: Extract<ResolvedMcpAgent, { kind: 'add-mcp' }>,
  runtimeEnv: NodeJS.ProcessEnv
): Promise<void> {
  const mcpUrl = firecrawlHostedMcpUrl();
  const apiKey = options.keyless ? undefined : getApiKey();
  // Codex has no Authorization template in environmentHeaderForAgent. Its
  // native bearer-token option is the verified env indirection, so this must
  // remain before the generic firecrawlMcpHeaders path.
  if (
    resolvedAgent.agent === 'codex' &&
    !options.project &&
    apiKey &&
    isEnvironmentBackedApiKey(apiKey, runtimeEnv)
  ) {
    installCodexMcpFromEnvironment(options, mcpUrl);
    return;
  }

  const headers = firecrawlMcpHeaders(resolvedAgent.agent, apiKey, runtimeEnv);
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

/** User settings file each config-file client reads its MCP servers from. */
function configFileMcpPath(client: ConfigFileClient): string {
  const home = os.homedir();
  switch (client) {
    case 'amp': {
      const settings = path.join(home, '.config', 'amp', 'settings.json');
      return !existsSync(settings) && existsSync(`${settings}c`)
        ? `${settings}c`
        : settings;
    }
    case 'grok-build':
      return path.join(home, '.grok', 'config.toml');
    case 'zed': {
      if (process.platform === 'win32') {
        const appData =
          process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
        return path.join(appData, 'Zed', 'settings.json');
      }
      const configHome =
        process.platform === 'linux' && process.env.XDG_CONFIG_HOME
          ? process.env.XDG_CONFIG_HOME
          : path.join(home, '.config');
      return path.join(configHome, 'zed', 'settings.json');
    }
  }
}

/** Set one server in a JSON or JSONC settings file, keeping comments and formatting. */
function upsertJsoncServer(
  content: string,
  keyPath: string[],
  entry: Record<string, unknown>,
  filePath: string
): string {
  if (stripComments(content).trim() !== '') {
    const errors: ParseError[] = [];
    const root = parseJsonc(content, errors, { allowTrailingComma: true });
    if (
      errors.length > 0 ||
      typeof root !== 'object' ||
      root === null ||
      Array.isArray(root)
    ) {
      throw new Error(
        `${filePath} is not valid JSON. Fix it, then rerun setup.`
      );
    }
  }
  try {
    const next = applyEdits(
      content,
      modify(content, keyPath, entry, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
    );
    return content ? next : `${next}\n`;
  } catch {
    throw new Error(
      `${filePath} has a ${keyPath[0]} value setup cannot update. Fix it, then rerun setup.`
    );
  }
}

/** Replace the [mcp_servers.firecrawl] table in a Grok config.toml, keeping everything else. */
function upsertGrokServer(
  content: string,
  entry: Record<string, unknown>,
  filePath: string
): string {
  const parseConfig = (text: string): Record<string, unknown> => {
    try {
      return parseToml(text);
    } catch {
      throw new Error(
        `${filePath} is not valid TOML. Fix it, then rerun setup.`
      );
    }
  };
  parseConfig(content);

  const firecrawlTable =
    /^\s*\[\s*mcp_servers\s*\.\s*(?:firecrawl|"firecrawl"|'firecrawl')\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
  const topLevel = tomlTopLevelLineStarts(content);
  let kept = '';
  let skipping = false;
  let offset = 0;
  for (const line of content.split(/(?<=\n)/)) {
    if (topLevel.has(offset) && /^\s*\[/.test(line)) {
      skipping = firecrawlTable.test(line.replace(/\r?\n$/, ''));
    }
    if (!skipping) kept += line;
    offset += line.length;
  }

  const servers = parseConfig(kept).mcp_servers;
  if (
    typeof servers === 'object' &&
    servers !== null &&
    'firecrawl' in servers
  ) {
    throw new Error(
      `${filePath} defines mcp_servers.firecrawl in a form setup cannot replace. Remove it, then rerun setup.`
    );
  }

  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const block = stringifyToml({ mcp_servers: { firecrawl: entry } })
    .trimEnd()
    .split('\n')
    .join(eol);
  let prefix = kept;
  if (prefix.trim()) {
    if (!prefix.endsWith('\n')) prefix += eol;
    if (!/\n\s*\n$/.test(prefix)) prefix += eol;
  }
  const next = `${prefix}${block}${eol}`;
  parseConfig(next);
  return next;
}

/** Offsets of the lines in a TOML document that start outside a string or comment. */
function tomlTopLevelLineStarts(content: string): Set<number> {
  const starts = new Set<number>();
  let state:
    | 'none'
    | 'basic'
    | 'literal'
    | 'ml-basic'
    | 'ml-literal'
    | 'comment' = 'none';
  for (let i = 0; i < content.length; i++) {
    if ((i === 0 || content[i - 1] === '\n') && state === 'none') starts.add(i);
    const char = content[i];
    if (char === '\n' && state !== 'ml-basic' && state !== 'ml-literal') {
      state = 'none';
      continue;
    }
    switch (state) {
      case 'comment':
        break;
      case 'basic':
        if (char === '\\') i++;
        else if (char === '"') state = 'none';
        break;
      case 'literal':
        if (char === "'") state = 'none';
        break;
      case 'ml-basic':
        if (char === '\\') i++;
        else if (content.startsWith('"""', i)) {
          i += 2;
          while (content[i + 1] === '"') i++;
          state = 'none';
        }
        break;
      case 'ml-literal':
        if (content.startsWith("'''", i)) {
          i += 2;
          while (content[i + 1] === "'") i++;
          state = 'none';
        }
        break;
      case 'none':
        if (char === '#') state = 'comment';
        else if (content.startsWith('"""', i)) {
          state = 'ml-basic';
          i += 2;
        } else if (content.startsWith("'''", i)) {
          state = 'ml-literal';
          i += 2;
        } else if (char === '"') state = 'basic';
        else if (char === "'") state = 'literal';
        break;
    }
  }
  return starts;
}

/** Write the hosted Firecrawl MCP entry into Amp, Grok Build or Zed user settings. */
async function installConfigFileMcp(
  client: ConfigFileClient,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  keyless = false
): Promise<void> {
  const { url, headers } = firecrawlMcpConfig(client, runtimeEnv, keyless);
  const entry = headers ? { url, headers } : { url };
  const configPath = configFileMcpPath(client);
  const existing = existsSync(configPath)
    ? readFileSync(configPath, 'utf-8')
    : '';
  const next =
    client === 'grok-build'
      ? upsertGrokServer(existing, entry, configPath)
      : upsertJsoncServer(
          existing,
          [
            client === 'amp' ? 'amp.mcpServers' : 'context_servers',
            'firecrawl',
          ],
          entry,
          configPath
        );

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, next, 'utf-8');
  console.log(
    `${CONFIG_FILE_CLIENTS[client]} MCP configured at ${configPath}.`
  );
}

export async function installHermesMcp(
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  keyless = false
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
  console.log(`Hermes Agent MCP configured at ${configPath}.`);
}

export async function installOpenClawMcp(
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  keyless = false
): Promise<void> {
  const config = {
    ...firecrawlMcpConfig('openclaw', runtimeEnv, keyless),
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
