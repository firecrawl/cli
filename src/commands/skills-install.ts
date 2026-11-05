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
 * `firecrawl init` installs core CLI skills and workflow skills.
 * `firecrawl setup skills` (alias `setup core`) installs core CLI skills,
 * `firecrawl setup build` installs build skills, and
 * `firecrawl setup workflows` installs workflow skills.
 */
import { detectGlobalSkillAgents } from '../utils/skill-install-agents';
import { getCatalogSkills, type SkillFamily } from '../utils/skill-catalog';

export const SKILL_REPOS = ['firecrawl/cli', 'firecrawl/skills'] as const;

export const WORKFLOW_SKILL_REPOS = ['firecrawl/firecrawl-workflows'] as const;

export const ALL_SKILL_REPOS = [
  ...SKILL_REPOS,
  ...WORKFLOW_SKILL_REPOS,
] as const;

/**
 * The skills catalog — the one promoted install source for every skill
 * family. `firecrawl init` installs from here so install volume accrues to
 * catalog counters on skills.sh.
 */
export const CATALOG_REPO = 'firecrawl/skills';

/**
 * Core skills, authored in firecrawl/cli and mirrored into the catalog under
 * skills/core/. Selection is name-based (`--skill`), so the catalog's
 * directory layout doesn't matter.
 */
export const CLI_SKILLS = [
  'firecrawl',
  'firecrawl-scrape',
  'firecrawl-search',
  'firecrawl-crawl',
  'firecrawl-map',
  'firecrawl-interact',
  'firecrawl-agent',
  'firecrawl-monitor',
  'firecrawl-parse',
  'firecrawl-download',
  'firecrawl-alexandria',
  // Index skills: teach the `firecrawl research` / `firecrawl developer`
  // CLI commands, so they ship with the CLI set.
  'firecrawl-research-index',
  'firecrawl-developer-index',
] as const;

/**
 * Build skills, authored in the firecrawl monorepo `skills/` and mirrored
 * into the catalog. App-integration guidance; not installed by `init`.
 */
export const BUILD_SKILLS = [
  'firecrawl-build',
  'firecrawl-build-onboarding',
  'firecrawl-build-scrape',
  'firecrawl-build-search',
  'firecrawl-build-interact',
] as const;

/** Workflow skills, authored in firecrawl/firecrawl-workflows and mirrored into the catalog. */
export const WORKFLOW_SKILLS = [
  'firecrawl-workflows',
  'firecrawl-business-contacts',
  'firecrawl-company-directories',
  'firecrawl-competitive-intel',
  'firecrawl-dashboard-reporting',
  'firecrawl-deep-research',
  'firecrawl-demo-walkthrough',
  'firecrawl-fantasy-sports',
  'firecrawl-job-postings',
  'firecrawl-knowledge-base',
  'firecrawl-knowledge-ingest',
  'firecrawl-lead-gen',
  'firecrawl-lead-research',
  'firecrawl-market-research',
  'firecrawl-qa',
  'firecrawl-research-papers',
  'firecrawl-seo-audit',
  'firecrawl-shop',
  'firecrawl-website-design-clone',
] as const;

/**
 * A family or named subset of catalog skills to install. Family installs
 * discover current members; explicit names preserve a user's selection.
 */
export interface SkillSelection {
  repo: string;
  /** Discover the whole family at install time, including newly published skills. */
  family?: SkillFamily;
  /** Explicit names when family is absent; otherwise the release's known names. */
  skills?: readonly string[];
  label: string;
}

export const CLI_SKILL_SELECTION: SkillSelection = {
  repo: CATALOG_REPO,
  family: 'core',
  skills: CLI_SKILLS,
  label: 'core firecrawl skills',
};

export const BUILD_SKILL_SELECTION: SkillSelection = {
  repo: CATALOG_REPO,
  family: 'build',
  skills: BUILD_SKILLS,
  label: 'firecrawl build skills',
};

export const WORKFLOW_SKILL_SELECTION: SkillSelection = {
  repo: CATALOG_REPO,
  family: 'workflows',
  skills: WORKFLOW_SKILLS,
  label: 'firecrawl workflow skills',
};

/** Resolve names for installers that accept a skill list rather than a family. */
export async function resolveSkillSelection(
  selection: SkillSelection
): Promise<readonly string[] | undefined> {
  if (!selection.family) return selection.skills;
  try {
    const names = (await getCatalogSkills())
      .filter((skill) => skill.family === selection.family)
      .map((skill) => skill.name);
    if (!names.length) throw new Error('No matching catalog skills');
    return names;
  } catch (error) {
    if (!selection.skills?.length) throw error;
    console.error(
      `Could not refresh the ${selection.family} catalog; using this CLI release's skill list. Newly published skills may be missing.`
    );
    return selection.skills;
  }
}

export interface SkillsInstallCommandOptions {
  agent?: string;
  all?: boolean;
  yes?: boolean;
  global?: boolean;
  includeNpxYes?: boolean;
  /** Repo to install from (defaults to firecrawl/cli) */
  repo?: string;
  /** Install only these skills (by name) instead of the whole repo. */
  skills?: readonly string[];
}

export function buildSkillsInstallArgs(
  options: SkillsInstallCommandOptions = {}
): string[] {
  const args = ['npx'];

  if (options.includeNpxYes) {
    args.push('-y');
  }

  // Keep the installer aligned with the registry in skill-install-agents.ts.
  args.push(
    'skills@1.7.2',
    'add',
    options.repo ?? 'firecrawl/cli',
    '--full-depth'
  );

  if (options.global ?? true) {
    args.push('--global');
  }

  // `skills add --all` means "ALL skills to all agents" and overrides any
  // --skill filter, so a skill-scoped install must never pass it. Scoped
  // installs use --yes instead so the --skill list is respected.
  const skillScoped = Boolean(options.skills?.length);
  const installToAllAgents =
    !skillScoped && (options.agent ? false : (options.all ?? true));
  if (installToAllAgents) {
    args.push('--all');
  }

  if (options.yes || skillScoped) {
    args.push('--yes');
  }

  if (options.agent) {
    args.push('--agent', options.agent);
  } else if (skillScoped && (options.global ?? true)) {
    // The installer's automatic targets include agents without global support.
    // Keep the shared ~/.agents/skills location via codex, plus detected global
    // targets. This preserves symlinks even with one detected agent.
    const agents = new Set(['codex', ...detectGlobalSkillAgents()]);
    args.push('--agent', ...agents);
  }

  // `skills add` collects space-separated names after a single --skill flag.
  if (options.skills) {
    args.push('--skill', ...options.skills);
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
