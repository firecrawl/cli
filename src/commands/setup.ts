/**
 * Setup command implementation
 * Installs firecrawl skill files and MCP server into AI coding agents
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
  agent?: string;
  undo?: boolean;
  /** Skip the interactive harness picker and apply to all agents. */
  yes?: boolean;
  /** Use the built-in skill installer instead of shelling out to npx skills. */
  nativeSkills?: boolean;
  /** Render compact skill install output. */
  quiet?: boolean;
}

const green = '\x1b[32m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

const SKILL_REPO_LABELS: Record<string, string> = {
  'firecrawl/cli': 'Core CLI skills',
  'firecrawl/skills': 'Build skills',
  'firecrawl/firecrawl-workflows': 'Workflow skills',
};

function skillRepoLabel(repo: string): string {
  return SKILL_REPO_LABELS[repo] ?? repo;
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

function firecrawlHostedMcpUrl(): string {
  const apiKey = getApiKey();
  if (apiKey) {
    return `https://mcp.firecrawl.dev/${encodeURIComponent(apiKey)}/v2/mcp`;
  }
  return 'https://mcp.firecrawl.dev/v2/mcp';
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

  const bundleOptions = { ...options, global: options.global ?? true };
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
  const resolvedAgent = resolveMcpAgent(options.agent);
  if (resolvedAgent.kind === 'hermes') {
    await installHermesMcp();
    return;
  }
  if (resolvedAgent.kind === 'openclaw') {
    await installOpenClawMcp();
    return;
  }
  if (resolvedAgent.kind === 'all-launchers') {
    await installAddMcp(
      { ...options, yes: true },
      { kind: 'add-mcp', all: true }
    );
    await installHermesMcp();
    await installOpenClawMcp();
    return;
  }

  await installAddMcp(options, resolvedAgent);
}

async function installAddMcp(
  options: SetupOptions,
  resolvedAgent: Extract<ResolvedMcpAgent, { kind: 'add-mcp' }>
): Promise<void> {
  const mcpUrl = firecrawlHostedMcpUrl();

  const args = [
    'npx',
    '-y',
    'add-mcp',
    shellQuote(mcpUrl),
    '--name',
    'firecrawl',
    '--transport',
    'http',
  ];

  if (options.global) {
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

  const cmd = args.join(' ');
  if (!options.quiet) {
    console.log(`Running: ${cmd}\n`);
  }

  try {
    execSync(cmd, {
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
    process.exit(1);
  }
}

function firecrawlMcpConfig(): {
  url: string;
  transport?: string;
} {
  return {
    url: firecrawlHostedMcpUrl(),
  };
}

export async function installHermesMcp(): Promise<void> {
  const config = firecrawlMcpConfig();
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
  writeFileSync(configPath, stringifyYaml(root), 'utf-8');
  console.log(`Hermes Agent MCP configured at ${configPath}.`);
}

export async function installOpenClawMcp(): Promise<void> {
  const config = {
    ...firecrawlMcpConfig(),
    transport: 'streamable-http',
  };
  const cmd = [
    'openclaw',
    'mcp',
    'set',
    'firecrawl',
    shellQuote(JSON.stringify(config)),
  ].join(' ');

  console.log(`Running: ${cmd}\n`);

  try {
    execSync(cmd, {
      stdio: 'inherit',
      env: cleanNpmEnv(),
    });
  } catch {
    process.exit(1);
  }
}
