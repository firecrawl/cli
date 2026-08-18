/**
 * Setup command implementation
 * Installs firecrawl skill files and MCP server into AI coding agents
 */

import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import readline from 'readline';
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
import {
  hasNpx,
  installSkillsNative,
  isSkillsAgentName,
} from './skills-native';
import {
  configureWebDefaults,
  WEB_AGENTS,
  type WebAgent,
  type WebDefaultResult,
} from '../utils/web-defaults';
import {
  ALL_MCP_CLIENT_IDS,
  FIRECRAWL_MCP_URL,
  ALL_MCP_LAUNCHER_IDS,
  ALL_MCP_TARGET_IDS,
  detectMcpClients,
  detectMcpLaunchers,
  FIRECRAWL_MCP_OAUTH_URL,
  isMcpLauncherId,
  MCP_CLIENTS,
  MCP_LAUNCHER_OAUTH,
  mcpTargetName,
  resolveMcpClientId,
  type McpAuthMode,
  type McpContext,
  type McpLauncherId,
  type McpTargetId,
} from '../utils/mcp-clients';
import { setupMcpClient, type McpClientResult } from '../utils/mcp-install';
import { runClientCommand } from '../utils/run-client-command';

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
  | { kind: 'launchers' }
  | { kind: 'skills-only'; agent: string }
  | { kind: 'openclaw' }
  | { kind: 'all-launchers' };

export interface SetupOptions {
  global?: boolean;
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
  /** Point agents at the sign-in endpoint instead of sending a credential. */
  oauth?: boolean;
  /** Agents chosen by flag (`--claude`, `--cursor`, ...); skips the picker. */
  clients?: McpTargetId[];
  /** Force the web-provider defaults step on or off instead of prompting. */
  defaults?: boolean;
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

function firecrawlHostedMcpUrl(oauth = false): string {
  return oauth ? FIRECRAWL_MCP_OAUTH_URL : FIRECRAWL_MCP_URL;
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
      return { kind: 'all-launchers' };
    case 'launchers':
    case 'launcher':
      return { kind: 'launchers' };
    case 'openclaw':
      return { kind: 'openclaw' };
    default: {
      const id = resolveMcpClientId(normalized);
      if (id) return { kind: 'clients', ids: [id] };
      // A name we install skills for but write no MCP config for is not an
      // error; the caller may have already installed skills for it.
      if (isSkillsAgentName(normalized)) {
        return { kind: 'skills-only', agent };
      }
      throw new Error(
        `Unknown agent "${agent}" for setup mcp. Use one of: ${ALL_MCP_TARGET_IDS.join(', ')}, all.`
      );
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
    global: options.global ?? true,
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

/**
 * Show the exact edit each agent will receive, then ask. These files belong to
 * the user, so nothing this command does should be a surprise afterwards, and
 * a value they set themselves is reported as kept rather than silently skipped.
 */
function tildePath(target: string): string {
  const home = os.homedir();
  return target.startsWith(home + path.sep)
    ? path.join('~', path.relative(home, target))
    : target;
}

async function confirmWebDefaults(
  plan: WebDefaultResult[],
  undo: boolean,
  framing: { headline?: string; question?: string } = {}
): Promise<boolean> {
  const changes = plan.filter((result) => result.changed);

  for (const result of plan) {
    if (result.preserved || result.skipped) {
      console.log(`${dim}${result.message}${reset}`);
    }
  }

  if (changes.length === 0) {
    console.log(
      undo
        ? 'Native web tools are already enabled for the selected agents.'
        : 'The selected agents are already set up. Nothing to change.'
    );
    return false;
  }

  console.log('');
  console.log(
    framing.headline ??
      (undo ? 'This will be reverted:' : 'This will be added:')
  );
  console.log('');
  for (const result of changes) {
    console.log(
      `  ${bold}${result.agent}${reset} ${dim}${tildePath(result.path)}${reset}`
    );
    if (result.preview) console.log(`    ${result.preview}`);
  }
  console.log('');

  const { confirm } = await import('@inquirer/prompts');
  return confirm({
    message: framing.question ?? 'Apply these changes?',
    default: true,
  });
}

/** Report what the defaults run actually did, shared by both entry points. */
function reportWebDefaults(results: WebDefaultResult[], undo: boolean): void {
  for (const result of results) {
    const prefix =
      result.skipped || result.preserved ? '!' : result.changed ? '✓' : '•';
    console.log(`${prefix} ${result.message}`);
    console.log(`  ${tildePath(result.path)}`);
  }

  console.log('');
  // An agent whose value we kept was not configured, so the closing line has to
  // stop short of claiming it was.
  const untouched = results.filter(
    (result) => result.preserved || result.skipped
  );
  if (results.length > 0 && untouched.length === results.length) {
    console.log('Nothing changed.');
  } else if (undo) {
    console.log('Native web tools restored where supported.');
  } else {
    console.log(
      'Firecrawl is now the default web provider for supported AI agents.'
    );
  }
  if (untouched.length > 0 && untouched.length < results.length) {
    console.log(
      `${dim}Left ${untouched.map((result) => result.agent).join(' and ')} as you had it.${reset}`
    );
  }
}

/** Agents that both host the MCP server and have a documented web-tool switch. */
const WEB_DEFAULT_BY_TARGET: Partial<Record<McpTargetId, WebAgent>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/**
 * Second step of `setup mcp`. Registering the server does not stop an agent
 * reaching for its own web tools first, so offer to hand those over as well.
 *
 * Only agents whose server entry landed in this run are offered, so the switch
 * is never thrown for an agent that has no Firecrawl server to fall back on.
 * Turning a built-in tool off is a real behavior change, so it is previewed
 * line by line and confirmed, and automation only gets it by asking.
 */
async function offerWebDefaults(
  options: SetupOptions,
  nonInteractive: boolean,
  agents: readonly WebAgent[]
): Promise<void> {
  if (agents.length === 0 || options.defaults === false) return;
  if (options.defaults === undefined && nonInteractive) return;

  const targets = [...new Set(agents)];

  if (options.defaults !== true) {
    const plan = await configureWebDefaults({
      undo: false,
      agents: targets,
      dryRun: true,
    });
    const confirmed = await confirmWebDefaults(plan, false, {
      headline: `Make Firecrawl the default web provider in ${targets.join(' and ')}? This turns off their own web search and fetch:`,
      question: 'Apply',
    });
    if (!confirmed) return;
  }

  console.log('');
  reportWebDefaults(
    await configureWebDefaults({ undo: false, agents: targets }),
    false
  );
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

  // `--yes` and non-interactive runs keep their existing behavior; a prompt
  // nobody can answer would just hang a script.
  if (!options.yes && process.stdin.isTTY) {
    const plan = await configureWebDefaults({ undo, agents, dryRun: true });
    if (!(await confirmWebDefaults(plan, undo))) return;
  }

  reportWebDefaults(await configureWebDefaults({ undo, agents }), undo);
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
  // True only when every agent this run targeted was configured. Quiet callers
  // report their own outcome and are not told about a partial run by an
  // exception, so they have to be told by the return value.
): Promise<boolean> {
  // Checked before anything else reports or returns, so no branch can accept a
  // combination the writers reject.
  if (options.oauth && options.keyless) {
    throw new Error(
      'Choose either --oauth or --keyless. Signing in and running anonymously are different endpoints.'
    );
  }

  const resolvedAgent = resolveMcpAgent(options.agent);

  if (resolvedAgent.kind === 'skills-only') {
    // Skills for this agent have already installed by this point; ending the
    // run here would fail a command that mostly succeeded.
    console.log(
      `Firecrawl does not write MCP config for ${resolvedAgent.agent}. Point it at ${FIRECRAWL_MCP_URL} to connect it yourself.`
    );
    return false;
  }

  if (resolvedAgent.kind === 'openclaw') {
    // Routed through the same reporter as every other target so the keyless
    // fallback is stated rather than implied by a bare installer log line.
    return installMcpClients(options, runtimeEnv, [resolvedAgent.kind]);
  }
  if (resolvedAgent.kind === 'launchers') {
    return installMcpClients(options, runtimeEnv, [...ALL_MCP_LAUNCHER_IDS]);
  }
  if (resolvedAgent.kind === 'all-launchers') {
    return installMcpClients(options, runtimeEnv, undefined, {
      includeAllLaunchers: true,
    });
  }

  return installMcpClients(options, runtimeEnv, resolvedAgent.ids);
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
    pageSize: detected.length,
    choices: detected.map((id) => ({
      name: mcpTargetName(id),
      value: id,
      checked: true,
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
    // The mode this run configured, which `keyless` cannot express: it folds
    // oauth in with keyless because neither sends a credential.
    auth: ctx.auth,
  };

  try {
    switch (id) {
      case 'openclaw':
        await installOpenClawMcp(
          runtimeEnv,
          keyless,
          true,
          ctx.auth === 'oauth'
        );
        result.mcpDetail = 'via the openclaw CLI';
        break;
      default: {
        const unreachable: never = id;
        throw new Error(`No installer for launcher ${String(unreachable)}`);
      }
    }
    result.mcpStatus = 'configured';
  } catch (error) {
    result.mcpDetail = error instanceof Error ? error.message : String(error);
  }

  return result;
}

async function installMcpClients(
  options: SetupOptions,
  runtimeEnv: NodeJS.ProcessEnv,
  explicitIds?: McpTargetId[],
  { includeAllLaunchers = false } = {}
): Promise<boolean> {
  const apiKey = options.oauth || options.keyless ? undefined : getApiKey();
  // Sign-in is a different endpoint rather than a different credential, so it
  // overrides the key lookup entirely. Otherwise a stored key cannot be written
  // into agent config, so authenticated setup requires the variable to be
  // exported where the agent will read it.
  const auth: McpAuthMode = options.oauth
    ? 'oauth'
    : isEnvironmentBackedApiKey(apiKey, runtimeEnv)
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
  // Prompts only make sense when someone is there to answer them.
  const nonInteractive = Boolean(options.yes) || !process.stdin.isTTY;

  // Naming targets is what skips the picker below; nothing here needs `yes`,
  // which would also answer the rules prompt on the user's behalf.
  let selected = includeAllLaunchers
    ? [...ALL_MCP_CLIENT_IDS]
    : (explicitIds ?? options.clients);
  if (!selected || selected.length === 0) {
    const detected: McpTargetId[] = [
      ...(await detectMcpClients(ctx)),
      ...detectMcpLaunchers(ctx),
    ];
    if (detected.length === 0 && !includeAllLaunchers) {
      const message =
        'No coding agents detected. Pass an agent flag such as --claude or --cursor.';
      // Interactive setup needs a picker. Non-interactive `-y` / `setup --yes`
      // must not fail the rest of the bundle after skills already installed.
      if (!nonInteractive) {
        throw new Error(message);
      }
      if (!options.quiet) console.log(message);
      return false;
    }
    if (nonInteractive) {
      selected = detected;
    } else {
      selected = await pickMcpClients(detected);
      if (selected.length === 0) {
        console.log('No agents selected. Nothing changed.');
        return false;
      }
    }
  }

  // `--agent all` reaches every integration whether or not it looks installed,
  // which is what the flag has always meant.
  if (includeAllLaunchers) {
    selected = [
      ...selected.filter((id) => !isMcpLauncherId(id)),
      ...ALL_MCP_LAUNCHER_IDS,
    ];
  }

  const results: McpClientResult[] = [];
  for (const id of selected) {
    results.push(
      isMcpLauncherId(id)
        ? await setupMcpLauncher(id, ctx, runtimeEnv)
        : await setupMcpClient(id, { ctx })
    );
  }

  reportMcpResults(results, ctx, options, Boolean(apiKey));

  // The handover is an offer on top of the work this command was asked to do,
  // so an unreadable settings file or a permissions error reports itself and
  // leaves the MCP result standing rather than failing the whole run.
  try {
    await offerWebDefaults(
      options,
      nonInteractive,
      results
        .filter((result) => result.mcpStatus !== 'failed')
        .map((result) => WEB_DEFAULT_BY_TARGET[result.id])
        .filter((agent): agent is WebAgent => agent !== undefined)
    );
  } catch (error) {
    console.log(
      `${red}Could not set the default web provider${reset} ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  assertMcpOutcome(results, options);

  return results.every((result) => result.mcpStatus !== 'failed');
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

  if (ctx.auth === 'oauth') {
    // Deliberately not "each agent prompts you": Codex, Hermes, and OpenClaw
    // wait for the command printed above their entry instead.
    return ['Sign in from each agent the first time you use it.'];
  }

  if (!hasApiKey) {
    return [
      `Running keyless (search, scrape, parse). Export ${ENV_API_KEY} where your agents run, then rerun to authenticate.`,
    ];
  }

  if (ctx.auth !== 'env') {
    return [
      `Configured keyless: your stored key is never written into agent config. Export ${ENV_API_KEY} where your agents run, then rerun to authenticate.`,
    ];
  }

  return [];
}

/**
 * The command that signs this agent in. Only the agents that need one say
 * anything: the rest prompt on their own, and the footer already tells the
 * person to expect that.
 */
function signInLine(
  result: McpClientResult,
  ctx: McpContext
): string | undefined {
  if (ctx.auth !== 'oauth' || result.mcpStatus === 'failed') return undefined;
  const spec = isMcpLauncherId(result.id)
    ? MCP_LAUNCHER_OAUTH[result.id]
    : MCP_CLIENTS[result.id].oauth;
  return spec?.nextStep
    ? `  Sign in: ${dim}${spec.nextStep}${reset}`
    : undefined;
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
    for (const note of authNotes(results, ctx, hasApiKey)) {
      console.log(`  ${dim}${note}${reset}`);
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
    const signIn = signInLine(result, ctx);
    if (signIn) console.log(signIn);
  }

  console.log('');
  console.log(
    `Firecrawl MCP set up for ${succeeded.length}/${results.length} agents. Restart your agents to load it.`
  );
  for (const note of authNotes(results, ctx, hasApiKey)) {
    console.log(`${dim}${note}${reset}`);
  }
}

/**
 * Raise the aggregate failure, kept apart from reporting so it can run after
 * the web-provider step. That step is already scoped to agents whose entry
 * landed, so one broken config must not cost a working agent the handover the
 * caller asked for.
 *
 * Quiet mode is embedded in a larger command that reports its own outcome, so
 * it still fails only when nothing landed at all.
 */
function assertMcpOutcome(
  results: McpClientResult[],
  options: SetupOptions
): void {
  const failed = results.filter((result) => result.mcpStatus === 'failed');
  if (failed.length === 0) return;

  if (options.quiet) {
    if (failed.length === results.length) {
      throw new Error('Failed to configure Firecrawl MCP.');
    }
    return;
  }

  throw new Error(
    `Firecrawl MCP failed for ${failed.map((result) => result.name).join(', ')}.`
  );
}

function firecrawlMcpConfig(
  agent?: string,
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  keyless = false,
  oauth = false
): {
  url: string;
  headers?: Record<string, string>;
  transport?: string;
} {
  return {
    url: firecrawlHostedMcpUrl(oauth),
    // Sign-in replaces the credential rather than travelling beside it, so the
    // key is dropped here too. Callers already choose one or the other, but a
    // helper this public must not put credential configuration on the sign-in
    // endpoint just because it was called directly.
    headers: firecrawlMcpHeaders(
      agent,
      keyless || oauth ? undefined : getApiKey(),
      runtimeEnv
    ),
  };
}

export async function installOpenClawMcp(
  runtimeEnv: NodeJS.ProcessEnv = process.env,
  keyless = false,
  /** Suppress standalone logging when a caller renders its own summary. */
  quiet = false,
  oauth = false
): Promise<void> {
  const config = {
    ...firecrawlMcpConfig('openclaw', runtimeEnv, keyless, oauth),
    transport: 'streamable-http',
    ...(oauth ? MCP_LAUNCHER_OAUTH.openclaw?.entry : undefined),
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
