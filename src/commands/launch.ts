import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';
import {
  installHermesMcp,
  installMcp,
  installOpenClawMcp,
  installSkillsForAgent,
} from './setup';
import { ALL_SKILL_REPOS } from './skills-install';
import { installRouterCard } from '../utils/router-card';

export interface LaunchOptions {
  config?: boolean;
  install?: boolean;
  setup?: boolean;
  global?: boolean;
  yes?: boolean;
  skipMcp?: boolean;
  skipSkills?: boolean;
  routerCard?: boolean;
  project?: string;
}

interface LaunchTarget {
  aliases: string[];
  displayName: string;
  mcpAgent?: string;
  mcpInstaller?: () => Promise<void>;
  skillsAgent?: string;
  command: string;
  args?: string[];
  supportsExtraArgs?: boolean;
  fallbackCommand?: (
    project: string
  ) => { command: string; args: string[] } | null;
  routerCardAgent: string;
}

type LaunchSetupMode = 'both' | 'mcp' | 'skills';

const TARGETS: LaunchTarget[] = [
  {
    aliases: ['claude', 'claude-code'],
    routerCardAgent: 'claude',
    displayName: 'Claude Code',
    mcpAgent: 'claude-code',
    skillsAgent: 'claude-code',
    command: 'claude',
    fallbackCommand: () => {
      const localClaude = path.join(os.homedir(), '.claude', 'local', 'claude');
      return existsSync(localClaude)
        ? { command: localClaude, args: [] }
        : null;
    },
  },
  {
    aliases: ['code', 'vscode', 'vs-code'],
    routerCardAgent: 'vscode',
    displayName: 'VS Code',
    mcpAgent: 'vscode',
    command: 'code',
    args: ['.'],
    fallbackCommand: (project) => {
      if (process.platform !== 'darwin') return null;
      return {
        command: 'open',
        args: ['-a', 'Visual Studio Code', project],
      };
    },
  },
  {
    aliases: ['codex'],
    routerCardAgent: 'codex',
    displayName: 'Codex',
    mcpAgent: 'codex',
    skillsAgent: 'codex',
    command: 'codex',
  },
  {
    aliases: ['codex-app', 'codex-desktop', 'codex-gui'],
    routerCardAgent: 'codex',
    displayName: 'Codex App',
    mcpAgent: 'codex',
    skillsAgent: 'codex',
    command: 'open',
    args: ['-b', 'com.openai.codex'],
    supportsExtraArgs: false,
    fallbackCommand: () => {
      if (process.platform !== 'darwin') return null;
      return {
        command: 'open',
        args: ['-a', 'Codex'],
      };
    },
  },
  {
    aliases: ['opencode', 'open-code'],
    routerCardAgent: 'opencode',
    displayName: 'OpenCode',
    mcpAgent: 'opencode',
    skillsAgent: 'opencode',
    command: 'opencode',
  },
  {
    aliases: ['hermes', 'hermes-agent'],
    routerCardAgent: 'hermes',
    displayName: 'Hermes Agent',
    mcpInstaller: installHermesMcp,
    skillsAgent: 'hermes-agent',
    command: 'hermes',
  },
  {
    aliases: ['openclaw'],
    routerCardAgent: 'openclaw',
    displayName: 'OpenClaw',
    mcpInstaller: installOpenClawMcp,
    skillsAgent: 'openclaw',
    command: 'openclaw',
    args: ['tui'],
  },
];

function findTarget(name: string | undefined): LaunchTarget | undefined {
  if (!name) return undefined;
  const normalized = name.trim().toLowerCase();
  return TARGETS.find((target) => target.aliases.includes(normalized));
}

function supportedTargets(): string {
  return TARGETS.flatMap((candidate) => candidate.aliases)
    .filter((alias, index, aliases) => aliases.indexOf(alias) === index)
    .join(', ');
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

async function pickLaunchTarget(): Promise<LaunchTarget> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Launch target is required in non-interactive mode. Supported: ${supportedTargets()}`
    );
  }

  console.log('Choose an app to configure and launch:');
  TARGETS.forEach((target, index) => {
    console.log(`  ${index + 1}. ${target.displayName}`);
  });
  console.log('');

  const answer = await promptInput('Launch app: ');
  const byNumber = Number.parseInt(answer, 10);
  if (
    Number.isInteger(byNumber) &&
    byNumber >= 1 &&
    byNumber <= TARGETS.length
  ) {
    return TARGETS[byNumber - 1];
  }

  const target = findTarget(answer);
  if (target) return target;

  throw new Error(
    `Unknown launch target "${answer}". Supported: ${supportedTargets()}`
  );
}

async function pickLaunchSetupMode(
  target: LaunchTarget
): Promise<LaunchSetupMode> {
  const { select } = await import('@inquirer/prompts');
  return select<LaunchSetupMode>({
    message: `Configure Firecrawl for ${target.displayName}`,
    choices: [
      {
        name: 'MCP + CLI skills',
        value: 'both',
        description: 'Configure tools and install all Firecrawl skills',
      },
      {
        name: 'MCP only',
        value: 'mcp',
        description: 'Only configure the Firecrawl MCP server',
      },
      {
        name: 'CLI skills only',
        value: 'skills',
        description: 'Only install Firecrawl skills for this agent',
      },
    ],
  });
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return (
    !result.error || (result.error as NodeJS.ErrnoException).code !== 'ENOENT'
  );
}

function resolveLaunchCommand(
  target: LaunchTarget,
  extraArgs: string[],
  project: string
): { command: string; args: string[] } {
  if (extraArgs.length > 0 && target.supportsExtraArgs === false) {
    throw new Error(`${target.displayName} does not accept extra arguments.`);
  }

  if (commandExists(target.command)) {
    return {
      command: target.command,
      args: [...(target.args || []), ...extraArgs],
    };
  }

  const fallback = target.fallbackCommand?.(project);
  if (fallback) {
    return {
      command: fallback.command,
      args: [...fallback.args, ...extraArgs],
    };
  }

  throw new Error(
    `${target.displayName} is not installed or its command was not found on PATH.`
  );
}

export async function handleLaunchCommand(
  targetName?: string,
  options: LaunchOptions = {},
  extraArgs: string[] = []
): Promise<void> {
  if (!targetName && extraArgs.length > 0) {
    throw new Error(
      'Extra launch arguments require an explicit launch target.'
    );
  }

  const target = targetName ? findTarget(targetName) : await pickLaunchTarget();
  if (!target) {
    throw new Error(
      `Unknown launch target "${targetName}". Supported: ${supportedTargets()}`
    );
  }

  const targetSupportsMcp = Boolean(target.mcpInstaller || target.mcpAgent);
  const targetSupportsSkills = Boolean(target.skillsAgent);
  const project = path.resolve(options.project ?? process.cwd());
  let installMcpForTarget = targetSupportsMcp && !options.skipMcp;
  let installSkillsForTarget = targetSupportsSkills && !options.skipSkills;

  if (
    installMcpForTarget &&
    installSkillsForTarget &&
    !options.yes &&
    process.stdin.isTTY
  ) {
    const setupMode = await pickLaunchSetupMode(target);
    installMcpForTarget = setupMode === 'both' || setupMode === 'mcp';
    installSkillsForTarget = setupMode === 'both' || setupMode === 'skills';
  }

  if (installMcpForTarget) {
    if (target.mcpInstaller) {
      await target.mcpInstaller();
    } else if (target.mcpAgent) {
      await installMcp({
        agent: target.mcpAgent,
        global: options.global !== false,
        yes: true,
        quiet: true,
      });
    }
    if (options.routerCard !== false) {
      const result = installRouterCard(target.routerCardAgent, project);
      console.log(
        `Firecrawl router card ${result.changed ? 'installed' : 'already current'} at ${result.path} (sha256:${result.sha256}).`
      );
    }
  }

  if (target.skillsAgent && installSkillsForTarget) {
    console.log(`Installing Firecrawl skills for ${target.displayName}...`);
    await installSkillsForAgent(
      target.skillsAgent,
      {
        global: options.global !== false,
        yes: true,
        nativeSkills: true,
        quiet: true,
      },
      ALL_SKILL_REPOS
    );
  }

  if (options.config || options.install || options.setup) {
    console.log(`${target.displayName} is configured with Firecrawl MCP.`);
    return;
  }

  const launch = resolveLaunchCommand(target, extraArgs, project);
  const result = spawnSync(launch.command, launch.args, {
    stdio: 'inherit',
    env: process.env,
    cwd: project,
  });

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}
