/**
 * Repos to pull skills from during install.
 *
 * - firecrawl/cli: core CLI skills bundled with this repo
 * - firecrawl/skills: additional "build" skills for working with Firecrawl
 *
 * Workflow skills live in a separate installable repo:
 *
 * - firecrawl/firecrawl-workflows: outcome-focused Firecrawl workflow skills
 *
 * `firecrawl init` installs both groups by default. `firecrawl setup skills`
 * installs core/build skills, and `firecrawl setup workflows` installs workflow
 * skills.
 */
import { detectInstalledAgentNames } from './skills-native';

export const SKILL_REPOS = ['firecrawl/cli', 'firecrawl/skills'] as const;

export const WORKFLOW_SKILL_REPOS = ['firecrawl/firecrawl-workflows'] as const;

export const ALL_SKILL_REPOS = [
  ...SKILL_REPOS,
  ...WORKFLOW_SKILL_REPOS,
] as const;

export interface SkillsInstallCommandOptions {
  agent?: string | string[];
  all?: boolean;
  yes?: boolean;
  global?: boolean;
  includeNpxYes?: boolean;
  /** Repo to install from (defaults to firecrawl/cli) */
  repo?: string;
}

/**
 * Resolve which agent(s) to install into.
 *
 * An explicit `--agent` or `--all` wins. Otherwise, install only into agents
 * actually detected on this machine — installing into every agent the
 * `skills` package knows about (most of which the user has never heard of)
 * is surprising and litters $HOME with dozens of unused directories. Falls
 * back to `--all` only if detection finds nothing, so non-interactive runs
 * never end up with no target at all.
 */
export function resolveSkillsTarget(options: {
  agent?: string;
  all?: boolean;
}): Pick<SkillsInstallCommandOptions, 'agent' | 'all'> {
  if (options.agent) return { agent: options.agent };
  if (options.all) return { all: true };

  const detected = detectInstalledAgentNames();
  return detected.length > 0 ? { agent: detected } : { all: true };
}

export function buildSkillsInstallArgs(
  options: SkillsInstallCommandOptions = {}
): string[] {
  const args = ['npx'];

  if (options.includeNpxYes) {
    args.push('-y');
  }

  args.push('skills', 'add', options.repo ?? 'firecrawl/cli', '--full-depth');

  if (options.global ?? true) {
    args.push('--global');
  }

  if (options.all) {
    args.push('--all');
  }

  if (options.yes) {
    args.push('--yes');
  }

  const agents = options.agent
    ? Array.isArray(options.agent)
      ? options.agent
      : [options.agent]
    : [];
  if (agents.length > 0) {
    args.push('--agent', ...agents);
  }

  return args;
}

/**
 * Build a clean env for `execSync('npx ...')` calls.
 *
 * When this CLI is itself launched by `npx -y firecrawl-cli@VERSION ...`, npm
 * injects env vars (`npm_command=exec`, `npm_lifecycle_event=npx`,
 * `npm_execpath`, `INIT_CWD`, etc.) that leak into nested npx subprocesses
 * and cause them to exit the parent process after the first invocation —
 * which silently breaks any loop that runs `npx skills add` more than once.
 *
 * Strip those vars so each nested npx call runs in a fresh-looking shell.
 */
export function cleanNpmEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_') || key === 'INIT_CWD' || key === 'PROJECT_CWD') {
      delete env[key];
    }
  }
  return env;
}
