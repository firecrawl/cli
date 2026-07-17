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
import { getApiKey } from '../utils/config';
import {
  installFullProjectRouterState,
  removeFullProjectRouterState,
  skippedFullProjectRouterState,
  type FullProjectRouterStateReceipt,
} from '../utils/project-router-state';
import {
  resolveRouterCardProject,
  type RouterCardAgent,
} from '../utils/router-card';

export interface LaunchOptions {
  config?: boolean;
  install?: boolean;
  setup?: boolean;
  global?: boolean;
  yes?: boolean;
  skipMcp?: boolean;
  skipSkills?: boolean;
  routerCard?: boolean;
  removeRouterCard?: boolean;
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
  fallbackCommand?: () => { command: string; args: string[] } | null;
  routerCardAgent?: RouterCardAgent;
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
    displayName: 'VS Code',
    mcpAgent: 'vscode',
    command: 'code',
    args: ['.'],
    fallbackCommand: () => {
      if (process.platform !== 'darwin') return null;
      return {
        command: 'open',
        args: ['-a', 'Visual Studio Code', process.cwd()],
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
    displayName: 'OpenCode',
    mcpAgent: 'opencode',
    skillsAgent: 'opencode',
    command: 'opencode',
  },
  {
    aliases: ['hermes', 'hermes-agent'],
    displayName: 'Hermes Agent',
    mcpInstaller: installHermesMcp,
    skillsAgent: 'hermes-agent',
    command: 'hermes',
  },
  {
    aliases: ['openclaw'],
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
  extraArgs: string[]
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

  const fallback = target.fallbackCommand?.();
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
): Promise<FullProjectRouterStateReceipt | undefined> {
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
  const launchProject = path.resolve(options.project ?? process.cwd());
  let routerReceipt: FullProjectRouterStateReceipt | undefined;
  const explicitlyEnableRouter = options.routerCard === true;
  const hasRouterOption =
    options.routerCard !== undefined || options.removeRouterCard;
  if (explicitlyEnableRouter && options.removeRouterCard) {
    throw new Error('Cannot combine --router-card with --remove-router-card.');
  }
  if (explicitlyEnableRouter && (options.skipMcp || options.skipSkills)) {
    throw new Error(
      '--router-card requires MCP and skills; remove --skip-mcp and --skip-skills.'
    );
  }
  if (hasRouterOption && !target.routerCardAgent) {
    throw new Error(
      'Project router state is currently supported for Claude and the Codex CLI.'
    );
  }
  if (explicitlyEnableRouter && !getApiKey()) {
    throw new Error(
      'Router state requires an API key plus successful MCP and skills setup.'
    );
  }
  const explicitRouterProject = hasRouterOption
    ? resolveRouterCardProject(options.project)
    : undefined;
  if (options.removeRouterCard || options.routerCard === false) {
    const receipt = removeFullProjectRouterState(
      target.routerCardAgent!,
      explicitRouterProject!
    );
    routerReceipt = receipt;
    console.log(
      `Firecrawl project routing disabled at ${receipt.project}; removed ${receipt.skills.removed.length} managed skill(s)${receipt.card?.changed ? ' and the router card' : ''}${receipt.skills.preserved.length > 0 ? `; preserved ${receipt.skills.preserved.length} modified or unsafe skill path(s)` : ''}${receipt.preservedCard ? '; preserved malformed or unsafe router-card content' : ''}. Re-enable with \`firecrawl launch ${target.aliases[0]} --router-card --project ${receipt.project}\`.`
    );
    if (options.removeRouterCard) return receipt;
  }
  let installMcpForTarget = targetSupportsMcp && !options.skipMcp;
  let installSkillsForTarget = targetSupportsSkills && !options.skipSkills;

  if (
    installMcpForTarget &&
    installSkillsForTarget &&
    !explicitlyEnableRouter &&
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

  const canInstallRouterState = Boolean(
    target.routerCardAgent &&
    options.routerCard !== false &&
    installMcpForTarget &&
    installSkillsForTarget &&
    getApiKey()
  );
  if (options.routerCard === true && !canInstallRouterState) {
    throw new Error(
      'Router state requires an API key plus successful MCP and skills setup.'
    );
  }
  if (canInstallRouterState) {
    let receipt: FullProjectRouterStateReceipt;
    try {
      const routerProject =
        explicitRouterProject ?? resolveRouterCardProject(options.project);
      receipt = installFullProjectRouterState({
        agent: target.routerCardAgent!,
        project: routerProject,
        authenticated: true,
        mcpInstalled: true,
        skillsInstalled: true,
        forceEnable: explicitlyEnableRouter,
      });
    } catch (error) {
      if (explicitlyEnableRouter) throw error;
      const warning =
        error instanceof Error
          ? error.message
          : 'unknown router delivery error';
      receipt = skippedFullProjectRouterState(
        target.routerCardAgent!,
        options.project ?? process.cwd(),
        warning
      );
      console.warn(
        `Firecrawl project routing skipped safely: ${warning} Ordinary ${target.displayName} setup will continue.`
      );
    }
    routerReceipt = receipt;
    if (receipt.status === 'disabled') {
      console.log(
        `Firecrawl project routing remains disabled at ${receipt.project}. Re-enable with \`firecrawl launch ${target.aliases[0]} --router-card --project ${receipt.project}\`.`
      );
    } else if (receipt.status !== 'skipped-safe') {
      console.log(
        `Firecrawl project routing ${receipt.status === 'current' ? 'is already current' : 'installed'} at ${receipt.project} (card sha256:${receipt.card!.sha256}; ${receipt.skills.sourceCount} routed skills).`
      );
    }
  }

  if (options.config || options.install || options.setup) {
    console.log(`${target.displayName} is configured with Firecrawl MCP.`);
    return routerReceipt;
  }

  const launch = resolveLaunchCommand(target, extraArgs);
  const result = spawnSync(launch.command, launch.args, {
    stdio: 'inherit',
    env: process.env,
    cwd: launchProject,
  });

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
  return routerReceipt;
}
