/**
 * Init command — interactive step-by-step wizard to set up Firecrawl.
 *
 * Usage:  npx -y firecrawl-cli init
 */

import { execSync } from 'child_process';
import {
  detectPackageManager,
  PACKAGE_MANAGERS,
  type PackageManager,
} from '../utils/package-manager';
import { isAuthenticated, browserLogin, interactiveLogin } from '../utils/auth';
import { saveCredentials } from '../utils/credentials';
import { updateConfig, getApiKey } from '../utils/config';
import {
  buildSkillsInstallArgs,
  cleanNpmEnv,
  CLI_SKILL_SELECTION,
  WORKFLOW_SKILL_SELECTION,
  WORKFLOW_SKILLS,
  type SkillSelection,
} from './skills-install';
import {
  hasNpx,
  installSkillsNative,
  detectInstalledAgentNames,
} from './skills-native';
import {
  configureWebDefaults,
  WEB_AGENTS,
  type WebAgent,
} from '../utils/web-defaults';
import { installMcp } from './setup';

export interface InitOptions {
  global?: boolean;
  agent?: string;
  all?: boolean;
  yes?: boolean;
  skipInstall?: boolean;
  skipSkills?: boolean;
  skipAuth?: boolean;
  apiKey?: string;
  browser?: boolean;
  template?: string;
}

const orange = '\x1b[38;5;208m';
const reset = '\x1b[0m';
const dim = '\x1b[2m';
const bold = '\x1b[1m';
const green = '\x1b[32m';

const TEMPLATES_REPO = 'firecrawl/cli-templates';

interface TemplateEntry {
  name: string;
  description: string;
  path: string; // subdirectory within the templates repo
}

export const TEMPLATES: TemplateEntry[] = [
  // Scraping
  {
    name: 'Scrape / Basic',
    description: 'Simple scrape + crawl scripts',
    path: 'scrape-basic',
  },
  {
    name: 'Scrape / Express',
    description: 'Express server with scrape, crawl, and search endpoints',
    path: 'scrape-express',
  },
  {
    name: 'Scrape / Next.js',
    description: 'Next.js app with server actions for scraping',
    path: 'scrape-nextjs',
  },

  // Browser
  {
    name: 'Browser / Basic',
    description: 'Playwright and Puppeteer CDP scripts with Firecrawl browser',
    path: 'browser-basic',
  },
  {
    name: 'Browser / Express',
    description: 'Express server with browser automation endpoints',
    path: 'browser-express',
  },
  {
    name: 'Browser / AI SDK',
    description:
      'Next.js browser co-pilot with Vercel AI SDK and live session UI',
    path: '_external:firecrawl/browser-ai-sdk',
  },

  // AI Frameworks
  {
    name: 'AI / Vercel AI SDK',
    description: 'Firecrawl tools with Vercel AI SDK',
    path: 'ai-vercel',
  },
  {
    name: 'AI / LangChain',
    description: 'Firecrawl tools with LangChain agents',
    path: 'ai-langchain',
  },

  // Full apps
  {
    name: 'Open Lovable',
    description: 'Clone and recreate any website as a modern React app',
    path: '_external:firecrawl/open-lovable',
  },
];

/**
 * Init selections extend the shared catalog selections with a retry hint.
 * `setup skills`/`setup workflows` install the same selections, so the hint
 * reinstalls exactly what init attempted.
 */
interface InitSkillSelection extends SkillSelection {
  retryCommand: string;
}

const INIT_CLI_SELECTION: InitSkillSelection = {
  ...CLI_SKILL_SELECTION,
  retryCommand: 'firecrawl setup skills',
};

const INIT_WORKFLOW_SELECTION: InitSkillSelection = {
  ...WORKFLOW_SKILL_SELECTION,
  retryCommand: 'firecrawl setup workflows',
};

/**
 * Install one skill repo quietly. Captures `npx skills add` output instead of
 * inheriting it, so users see a single line per repo. Returns the number of
 * skills installed (parsed from the captured stdout), or null if unknown.
 *
 * In a TTY, shows a transient "↓ Installing <label>..." line that gets
 * overwritten by "✓ <label> (N)" on success. In a non-TTY, prints only
 * the final line.
 */
async function installSkillRepoQuiet(
  selection: SkillSelection,
  options: InitOptions
): Promise<number | null> {
  const { repo, label } = selection;

  // Prefer the native installer when we can detect installed harnesses.
  // It creates symlinks to ~/.agents/skills/ (single source of truth) and
  // only touches agents whose ~/.<agent> dirs actually exist — unlike
  // `npx skills add --all` which sprays to every agent npx knows about.
  const detected = detectInstalledAgentNames();
  const useNative =
    // Explicit --agent → always native (scoped + symlinked)
    options.agent ||
    // No --all flag → native with detected agents only
    !options.all ||
    // --all but nothing detected locally → native will detect + symlink
    detected.length > 0;

  if (useNative) {
    try {
      const result = await installSkillsNative(repo, {
        agent: options.agent,
        quiet: true,
        skills: selection.skills,
      });
      const suffix = ` ${dim}(${result.skillCount})${reset}`;
      const linked =
        result.linkedAgents.length > 0
          ? ` ${dim}→ ${result.linkedAgents.join(', ')}${reset}`
          : '';
      console.log(`  ${green}✓${reset} ${label}${suffix}${linked}`);
      return result.skillCount;
    } catch (err) {
      console.log(`  ${dim}✗${reset} ${label}`);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`    ${dim}${msg}${reset}`);

      // Fall through to npx if native failed and npx is available
      if (!hasNpx()) throw err;
      console.log(`  ${dim}Retrying with npx...${reset}`);
    }
  }

  // Fallback: npx skills add (copies files, may spray to all agents)
  if (hasNpx()) {
    const args = buildSkillsInstallArgs({
      repo,
      agent: options.agent,
      yes: options.yes || options.all || true,
      global: true,
      includeNpxYes: true,
      skills: selection.skills,
    });

    const isTty = process.stdout.isTTY;
    if (isTty) {
      process.stdout.write(`  ${dim}↓ Installing ${label}...${reset}`);
    }
    try {
      const stdout = execSync(args.join(' '), {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: cleanNpmEnv(),
      });
      const count = parseSkillCount(stdout?.toString() ?? '');
      const suffix = count != null ? ` ${dim}(${count})${reset}` : '';
      const padding = ' '.repeat(20); // clears any leftover "Installing..." text
      if (isTty) {
        process.stdout.write(
          `\r  ${green}✓${reset} ${label}${suffix}${padding}\n`
        );
      } else {
        console.log(`  ${green}✓${reset} ${label}${suffix}`);
      }
      return count;
    } catch (err) {
      if (isTty) {
        process.stdout.write(`\r  ${dim}✗ ${label}${' '.repeat(20)}${reset}\n`);
      } else {
        console.log(`  ${dim}✗${reset} ${label}`);
      }
      const stderr =
        err && typeof err === 'object' && 'stderr' in err
          ? String((err as { stderr: Buffer | string }).stderr || '')
          : '';
      if (stderr.trim()) {
        console.error(
          stderr
            .trim()
            .split('\n')
            .map((l) => `    ${dim}${l}${reset}`)
            .join('\n')
        );
      }
      throw err;
    }
  }

  throw new Error('No skills installer is available.');
}

/**
 * Prompt for which harnesses should receive the skills. Returns an explicit
 * subset, or `null` to mean "all detected agents" (the broad `--all` path,
 * which also covers agents npx knows about but that aren't detected locally).
 */
async function pickHarnesses(): Promise<string[] | null> {
  const detected = detectInstalledAgentNames();
  // Nothing detected locally — fall back to the broad install.
  if (detected.length === 0) return null;

  const { checkbox } = await import('@inquirer/prompts');
  const selected = await checkbox<string>({
    message: 'Which agents/harnesses should get the skills?',
    choices: detected.map((name) => ({ name, value: name, checked: true })),
  });

  // Empty selection or "all of them" both map to the broad --all install.
  if (selected.length === 0 || selected.length === detected.length) return null;
  return selected;
}

/**
 * Install one skill repo across the chosen harnesses. `agents === null` lets
 * the native installer detect and symlink to every installed harness in one
 * pass; otherwise the repo is linked into each named agent individually.
 * The skill count is reported once (the same skills are symlinked to each
 * agent), so a multi-agent install does not inflate the total.
 */
async function installRepoAcrossAgents(
  selection: SkillSelection,
  options: InitOptions,
  agents: string[] | null
): Promise<number | null> {
  if (!agents) {
    return installSkillRepoQuiet(selection, options);
  }

  let count: number | null = null;
  for (const agent of agents) {
    const c = await installSkillRepoQuiet(selection, { ...options, agent });
    if (count == null) count = c;
  }
  return count;
}

/** Parse "Found N skills" or "Installed N skills" from npx skills output. */
function parseSkillCount(output: string): number | null {
  const match = output.match(/(?:Found|Installed)\s+(\d+)\s+skills?/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Print the post-install next-steps block. Brief by design — confirms what was
 * installed and gives 4 entry points (AI prompt, direct CLI, MCP, help).
 */
function printNextSteps(
  skillCount: number | null,
  defaultsHandled = false,
  skillsInstalled = true,
  cliCommand = 'firecrawl'
): void {
  const arrow = `${dim}→${reset}`;
  const summary =
    skillCount != null
      ? `${green}✓${reset} Installed ${bold}${skillCount} skills${reset} ${dim}across your AI coding agents${reset}`
      : `${green}✓${reset} Skills installed ${dim}across your AI coding agents${reset}`;

  console.log('');
  if (skillsInstalled) console.log(`  ${summary}`);
  console.log('');
  console.log(
    `  ${dim}Connect & interact with the web ${reset}${dim}(direct or in your AI agent):${reset}`
  );
  console.log(
    `    ${arrow} ${bold}Scrape${reset}    "Scrape the pricing page of stripe.com"    ${dim}${cliCommand} scrape https://stripe.com/pricing${reset}`
  );
  console.log(
    `    ${arrow} ${bold}Search${reset}    "Search for the latest stories in AI"      ${dim}${cliCommand} search "latest stories in AI"${reset}`
  );
  console.log(
    `    ${arrow} ${bold}Interact${reset}  "Go to amazon.com, search keyboards, filter by Prime"  ${dim}${cliCommand} interact "search keyboards, filter by Prime"${reset}`
  );
  console.log('');
  console.log(
    `  ${arrow} ${dim}Add MCP:     ${reset} ${bold}${cliCommand} setup mcp${reset}`
  );
  if (!defaultsHandled) {
    console.log(
      `  ${arrow} ${dim}Default web:${reset} ${bold}${cliCommand} setup defaults${reset}`
    );
  }
  console.log(
    `  ${arrow} ${dim}Make default:${reset} ${bold}${cliCommand} make default${reset}`
  );
  console.log(
    `  ${arrow} ${dim}All commands:${reset} ${bold}${cliCommand} --help${reset}`
  );
  console.log('');
  console.log(
    `  ${dim}Building with firecrawl? Just describe what you want to build or integrate.${reset}`
  );
  console.log(
    `  ${dim}Example:${reset} ${bold}"I want to use firecrawl to build an onboarding flow for my insurance company"${reset}`
  );
  console.log('');
}

/** True if the `firecrawl` command is resolvable on the current PATH. */
function cliIsOnPath(): boolean {
  try {
    const cmd =
      process.platform === 'win32' ? 'where firecrawl' : 'command -v firecrawl';
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Resolve the selected package manager's global executable directory. */
function globalBinDir(manager: PackageManager): string | null {
  try {
    const prefix = execSync(PACKAGE_MANAGERS[manager].bin, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
      .toString()
      .trim();
    if (!prefix) return null;
    // npm returns a prefix; pnpm and Bun return the executable directory.
    return manager === 'npm' && process.platform !== 'win32'
      ? `${prefix}/bin`
      : prefix;
  } catch {
    return null;
  }
}

/** Best-guess rc file to append a PATH export to, based on the user's shell. */
function rcFileForShell(): string {
  const shell = process.env.SHELL ?? '';
  if (shell.includes('zsh')) return '~/.zshrc';
  if (shell.includes('fish')) return '~/.config/fish/config.fish';
  if (shell.includes('bash'))
    return process.platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc';
  return '~/.profile';
}

/**
 * After a global install, confirm `firecrawl` is actually reachable.
 *
 * On many machines the binary installs fine but its bin dir isn't on PATH —
 * a custom npm prefix (`npm config set prefix ~/.npm-global`), nvm/volta, or a
 * fresh Windows shell. The install reports success, yet the command silently
 * doesn't exist in any new terminal. Detect that and print the exact fix.
 */
function warnIfCliNotOnPath(manager: PackageManager): void {
  if (cliIsOnPath()) return;

  const bin = globalBinDir(manager);
  console.log('');
  console.log(
    `  ${bold}⚠ "firecrawl" was installed but isn't on your PATH yet.${reset}`
  );
  if (bin && process.platform === 'win32') {
    console.log(
      `  ${dim}Add this directory to your PATH, then open a new terminal:${reset}`
    );
    console.log(`    ${bold}${bin}${reset}`);
  } else if (bin) {
    const rc = rcFileForShell();
    const line = rc.includes('fish')
      ? `fish_add_path ${bin}`
      : `export PATH="${bin}:$PATH"`;
    console.log(
      `  ${dim}Add it to your shell, then restart your terminal:${reset}`
    );
    console.log(`    ${bold}echo '${line}' >> ${rc}${reset}`);
  } else {
    console.log(
      `  ${dim}Add your global bin directory (see "${PACKAGE_MANAGERS[manager].bin}") to PATH.${reset}`
    );
  }
  console.log(
    `  ${dim}Until then you can still run:${reset} ${bold}${PACKAGE_MANAGERS[manager].run} <command>${reset}`
  );
  console.log('');
}

async function stepInstall(): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts');
  const shouldInstall = await confirm({
    message: 'Install firecrawl-cli globally?',
    default: true,
  });

  if (!shouldInstall) return true;

  console.log(`\n  Installing firecrawl-cli globally...`);
  return installGlobalCli();
}

function installGlobalCli(): boolean {
  const manager = detectPackageManager();
  const commands = PACKAGE_MANAGERS[manager];
  try {
    const version = execSync(`${manager} --version`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      timeout: 10_000,
    })
      .toString()
      .trim();
    console.log(
      `  Using ${manager} ${version} from PATH (Node ${process.version})`
    );
    if (
      !/^\d+\.\d+\.\d+/.test(version) ||
      (manager === 'npm' && Number(version.split('.')[0]) < 7)
    ) {
      throw new Error(
        `Unsupported ${manager} version ${version}. Update ${manager} and check your PATH before retrying.`
      );
    }
    execSync(commands.install, { stdio: 'inherit', env: process.env });
    console.log(`${green}✓${reset} CLI installed globally\n`);
    warnIfCliNotOnPath(manager);
    return true;
  } catch (error) {
    console.error(`Failed to install firecrawl-cli globally using ${manager}.`);
    console.error(
      error instanceof Error ? error.message : 'Unknown install error'
    );
    console.error(
      `Check "${manager} --version" and your PATH. Retry: ${commands.install}`
    );
    if (manager === 'pnpm')
      console.error(
        'If the global bin directory is missing, run "pnpm setup" and restart your shell.'
      );
    console.log(
      `You can run without a global install: ${commands.run} <command>`
    );
    return false;
  }
}

export async function stepAuth(options: InitOptions): Promise<boolean> {
  if (options.apiKey) {
    try {
      saveCredentials({ apiKey: options.apiKey });
      updateConfig({ apiKey: options.apiKey });
      console.log(`  ${green}✓${reset} Authenticated with provided API key\n`);
      return true;
    } catch (error) {
      console.error(
        '  Failed to save credentials:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      return false;
    }
  }

  if (isAuthenticated()) {
    console.log(`  ${green}✓${reset} Already authenticated\n`);
    return true;
  }

  const { select } = await import('@inquirer/prompts');
  const method = await select({
    message: 'How would you like to authenticate?',
    choices: [
      { name: 'Login via browser (recommended)', value: 'browser' },
      { name: 'Enter API key manually', value: 'manual' },
      {
        name: 'Continue without an API key (limited free tier)',
        value: 'skip',
      },
    ],
  });

  if (method === 'skip') {
    console.log(
      `  ${dim}Continuing without an API key. scrape, search, and interact work on the limited free tier (rate-limited per IP).${reset}`
    );
    console.log(
      `  ${dim}Run "firecrawl login" anytime to unlock every command and higher limits.${reset}\n`
    );
    return true;
  }

  try {
    let result: { apiKey: string; apiUrl?: string; teamName?: string };
    if (method === 'browser') {
      result = await browserLogin();
    } else {
      result = await interactiveLogin();
    }

    saveCredentials({ apiKey: result.apiKey, apiUrl: result.apiUrl });
    updateConfig({ apiKey: result.apiKey, apiUrl: result.apiUrl });

    const teamSuffix = result.teamName ? ` (Team: ${result.teamName})` : '';
    console.log(`  ${green}✓${reset} Authenticated${teamSuffix}\n`);
    return true;
  } catch (error) {
    console.error(
      '  Authentication failed:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    console.log(
      `  ${dim}You can authenticate later with: firecrawl login${reset}\n`
    );
    return true;
  }
}

async function stepIntegrations(
  options: InitOptions
): Promise<{ skillCount: number | null; skillsInstalled: boolean }> {
  const { checkbox, confirm } = await import('@inquirer/prompts');

  const wantIntegrations = await confirm({
    message: 'Set up integrations (skills, workflows, MCP, env)?',
    default: true,
  });

  if (!wantIntegrations) return { skillCount: null, skillsInstalled: false };

  const integrations = await checkbox<string>({
    message: 'Which integrations?',
    choices: [
      {
        name: 'Skills — install core Firecrawl CLI skills for AI coding agents',
        value: 'skills',
        checked: true,
      },
      {
        name: 'Workflows — pick Firecrawl workflow skills to install',
        value: 'workflows',
        checked: true,
      },
      {
        name: 'MCP — install firecrawl MCP server for editors (Cursor, Claude Code, VS Code)',
        value: 'mcp',
      },
      {
        name: 'Env — pull FIRECRAWL_API_KEY into local .env file',
        value: 'env',
      },
    ],
  });

  if (integrations.length === 0) {
    console.log(`  ${dim}No integrations selected.${reset}\n`);
    return { skillCount: null, skillsInstalled: false };
  }

  // If skills/workflows are being installed, let the user route them to a
  // subset of harnesses. An explicit --agent flag wins and skips the prompt;
  // otherwise the default is every detected harness (null → --all).
  const installsSkills =
    integrations.includes('skills') || integrations.includes('workflows');
  const targetAgents: string[] | null =
    installsSkills && !options.agent
      ? await pickHarnesses()
      : options.agent
        ? [options.agent]
        : null;

  let totalSkills: number | null = null;
  let skillsInstalled = false;
  for (const integration of integrations) {
    switch (integration) {
      case 'skills': {
        console.log(`\n  Installing skills...`);
        try {
          const count = await installRepoAcrossAgents(
            CLI_SKILL_SELECTION,
            options,
            targetAgents
          );
          skillsInstalled = true;
          if (count != null) totalSkills = (totalSkills ?? 0) + count;
        } catch {
          console.error(
            `  ${dim}Run "firecrawl setup skills" later to retry.${reset}`
          );
        }
        break;
      }
      case 'workflows': {
        const { checkbox: pickWorkflows } = await import('@inquirer/prompts');
        const chosen = await pickWorkflows<string>({
          message: 'Which workflow skills?',
          choices: WORKFLOW_SKILLS.map((name) => ({
            name,
            value: name,
            checked: true,
          })),
        });
        if (chosen.length === 0) {
          console.log(`  ${dim}No workflow skills selected.${reset}`);
          break;
        }
        console.log(`\n  Installing workflow skills...`);
        try {
          const count = await installRepoAcrossAgents(
            { ...WORKFLOW_SKILL_SELECTION, skills: chosen },
            options,
            targetAgents
          );
          skillsInstalled = true;
          if (count != null) totalSkills = (totalSkills ?? 0) + count;
        } catch {
          console.error(
            `  ${dim}Run "firecrawl setup workflows" later to retry (installs all workflow skills).${reset}`
          );
        }
        break;
      }
      case 'mcp': {
        console.log(`\n  Setting up MCP server...`);
        const apiKey = getApiKey();
        const environmentBacked = Boolean(
          apiKey && process.env.FIRECRAWL_API_KEY === apiKey
        );
        try {
          await installMcp({
            global: options.global,
            agent: options.agent ?? (environmentBacked ? 'all' : undefined),
            yes: true,
            quiet: true,
            // Stored credentials must never be persisted into MCP client config.
            // Install the anonymous endpoint instead; an environment-backed
            // credential continues through the authenticated setup path.
            keyless: !environmentBacked,
          });
          console.log(`  ${green}✓${reset} MCP server installed`);
        } catch (error) {
          const message =
            error instanceof Error
              ? apiKey
                ? error.message.replaceAll(apiKey, '[REDACTED]')
                : error.message
              : 'unknown error';
          console.error(`  Failed to install MCP securely: ${message}`);
        }
        break;
      }
      case 'env': {
        console.log(`\n  Pulling API key into .env...`);
        try {
          const { handleEnvPullCommand } = await import('./env');
          await handleEnvPullCommand({});
          console.log(`  ${green}✓${reset} .env updated`);
        } catch {
          console.error('  Failed to update .env. Run "firecrawl env" later.');
        }
        break;
      }
    }
  }
  return { skillCount: totalSkills, skillsInstalled };
}

/**
 * Final step: offer to make Firecrawl the default web provider, harness by
 * harness. Shown right before the next-steps screen.
 */
async function stepDefaults(): Promise<void> {
  const { confirm, checkbox } = await import('@inquirer/prompts');

  const want = await confirm({
    message:
      'Set Firecrawl as the default web provider? (disables native web search/fetch in Claude Code/Codex)',
    default: true,
  });
  if (!want) return;

  const harnesses = await checkbox<WebAgent>({
    message: 'For which harnesses?',
    choices: WEB_AGENTS.map((agent) => ({
      name: agent,
      value: agent,
      checked: true,
    })),
  });
  if (harnesses.length === 0) {
    console.log(`  ${dim}No harnesses selected — skipped.${reset}`);
    return;
  }

  console.log(`\n  Configuring default web provider...`);
  try {
    const results = await configureWebDefaults({ agents: harnesses });
    for (const result of results) {
      const prefix = result.skipped
        ? '!'
        : result.changed
          ? green + '✓' + reset
          : dim + '•' + reset;
      console.log(`  ${prefix} ${result.message}`);
    }
  } catch {
    console.error(
      '  Failed to set defaults. Run "firecrawl setup defaults" later.'
    );
  }
}

function copyTemplateFiles(
  srcDir: string,
  targetDir: string,
  fs: typeof import('fs'),
  path: typeof import('path')
): void {
  const entries = fs.readdirSync(srcDir);
  for (const entry of entries) {
    if (entry === '.git') continue;
    const src = path.join(srcDir, entry);
    const dest = path.join(targetDir, entry);
    if (fs.existsSync(dest)) {
      console.log(`  ${dim}skip${reset}  ${entry} (already exists)`);
      continue;
    }
    fs.cpSync(src, dest, { recursive: true });
    console.log(`  ${green}+${reset}     ${entry}`);
  }
}

async function downloadFromRepo(
  repo: string,
  subdir: string | null
): Promise<void> {
  const fs = await import('fs');
  const path = await import('path');
  const { execSync: exec } = await import('child_process');
  const targetDir = process.cwd();
  const tmpDir = path.join(targetDir, `.firecrawl-template-${Date.now()}`);

  // Try sparse checkout for subdirectory, full clone for whole repo
  try {
    if (subdir) {
      fs.mkdirSync(tmpDir, { recursive: true });
      exec(
        `git clone --depth 1 --filter=blob:none --sparse https://github.com/${repo}.git "${tmpDir}"`,
        { stdio: 'pipe' }
      );
      exec(`git -C "${tmpDir}" sparse-checkout set "${subdir}"`, {
        stdio: 'pipe',
      });
      const srcDir = path.join(tmpDir, subdir);
      if (!fs.existsSync(srcDir)) {
        throw new Error(`Template directory "${subdir}" not found in ${repo}`);
      }
      copyTemplateFiles(srcDir, targetDir, fs, path);
    } else {
      exec(`git clone --depth 1 https://github.com/${repo}.git "${tmpDir}"`, {
        stdio: 'pipe',
      });
      copyTemplateFiles(tmpDir, targetDir, fs, path);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  } catch (gitError) {
    // Clean up failed git attempt
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Fallback: download tarball and extract
  const https = await import('https');
  const tarballUrl = `https://api.github.com/repos/${repo}/tarball`;

  await new Promise<void>((resolve, reject) => {
    const request = (url: string) => {
      https.get(
        url,
        {
          headers: {
            'User-Agent': 'firecrawl-cli',
            Accept: 'application/vnd.github+json',
          },
        },
        (res) => {
          if (res.statusCode === 302 && res.headers.location) {
            request(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API returned ${res.statusCode}`));
            return;
          }

          const tmpTar = path.join(
            targetDir,
            `.firecrawl-template-${Date.now()}.tar.gz`
          );
          const fileStream = fs.createWriteStream(tmpTar);
          res.pipe(fileStream);
          fileStream.on('finish', () => {
            fileStream.close();
            try {
              const extractDir = path.join(
                targetDir,
                `.firecrawl-template-extract-${Date.now()}`
              );
              fs.mkdirSync(extractDir, { recursive: true });
              exec(
                `tar -xzf "${tmpTar}" -C "${extractDir}" --strip-components=1`,
                { stdio: 'pipe' }
              );

              const srcDir = subdir
                ? path.join(extractDir, subdir)
                : extractDir;
              if (!fs.existsSync(srcDir)) {
                throw new Error(
                  `Template directory "${subdir}" not found in tarball`
                );
              }
              copyTemplateFiles(srcDir, targetDir, fs, path);

              fs.rmSync(tmpTar, { force: true });
              fs.rmSync(extractDir, { recursive: true, force: true });
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        }
      );
    };
    request(tarballUrl);
  });
}

async function stepTemplate(): Promise<void> {
  const { select, confirm: confirmPrompt } = await import('@inquirer/prompts');

  const wantTemplate = await confirmPrompt({
    message: 'Start from a template?',
    default: false,
  });

  if (!wantTemplate) return;

  const template = await select({
    message: 'Choose a template',
    choices: TEMPLATES.map((t) => ({
      name: `${t.name}  ${dim}${t.description}${reset}`,
      value: t,
    })),
  });

  const isExternal = template.path.startsWith('_external:');
  const repo = isExternal
    ? template.path.replace('_external:', '')
    : TEMPLATES_REPO;
  const subdir = isExternal ? null : template.path;

  console.log(`\n  Downloading ${bold}${template.name}${reset}...`);
  console.log(
    `  ${dim}github.com/${repo}${subdir ? '/' + subdir : ''}${reset}\n`
  );
  try {
    await downloadFromRepo(repo, subdir);
    console.log(`\n  ${green}✓${reset} Template ready\n`);
  } catch (error) {
    console.error(`\n  ${bold}Could not download template.${reset}`);
    console.error(
      `  ${dim}${error instanceof Error ? error.message : 'Unknown error'}${reset}\n`
    );
    console.log(`  Clone it manually:\n`);
    console.log(
      `    git clone https://github.com/${repo}.git${subdir ? ' && cp -r ' + repo.split('/')[1] + '/' + subdir + '/* .' : ''}\n`
    );
  }
}

export function findTemplate(name: string): TemplateEntry | undefined {
  const lower = name.toLowerCase();
  return TEMPLATES.find((t) => {
    const path = t.path.replace('_external:', '').split('/').pop() ?? '';
    return path === lower || t.name.toLowerCase() === lower;
  });
}

export async function scaffoldTemplate(templatePath: string): Promise<void> {
  const template = findTemplate(templatePath);
  if (!template) {
    console.error(`\n  Unknown template: ${bold}${templatePath}${reset}\n`);
    console.log(`  Available templates:\n`);
    for (const t of TEMPLATES) {
      const key = t.path.replace('_external:', '').split('/').pop() ?? '';
      console.log(`    ${bold}${key}${reset}  ${dim}${t.description}${reset}`);
    }
    console.log('');
    process.exit(1);
  }

  const isExternal = template.path.startsWith('_external:');
  const repo = isExternal
    ? template.path.replace('_external:', '')
    : TEMPLATES_REPO;
  const subdir = isExternal ? null : template.path;

  console.log('');
  console.log(
    `  ${orange}🔥 ${bold}firecrawl${reset} ${dim}${template.name}${reset}`
  );
  console.log(
    `  ${dim}github.com/${repo}${subdir ? '/' + subdir : ''}${reset}\n`
  );
  try {
    await downloadFromRepo(repo, subdir);
    console.log(`\n  ${green}✓${reset} Template ready\n`);
  } catch (error) {
    console.error(`\n  ${bold}Could not download template.${reset}`);
    console.error(
      `  ${dim}${error instanceof Error ? error.message : 'Unknown error'}${reset}\n`
    );
    console.log(`  Clone it manually:\n`);
    console.log(
      `    git clone https://github.com/${repo}.git${subdir ? ' && cp -r ' + repo.split('/')[1] + '/' + subdir + '/* .' : ''}\n`
    );
    process.exit(1);
  }
}

export async function handleInitCommand(
  options: InitOptions = {}
): Promise<void> {
  // Direct template scaffold: firecrawl init browser-nextjs
  if (options.template) {
    await scaffoldTemplate(options.template);
    return;
  }

  console.log('');
  console.log(`  ${orange}🔥 ${bold}firecrawl${reset} ${dim}init${reset}`);
  console.log('');

  // Non-interactive mode (--yes or --all skips all prompts)
  if (options.yes || options.all) {
    await runNonInteractive(options);
    return;
  }

  let installFailed = false;
  // Step 1: Install
  if (!options.skipInstall) {
    const ok = await stepInstall();
    if (!ok) {
      installFailed = true;
      console.log(`  ${dim}Continuing with setup...${reset}\n`);
    }
  }

  // Step 2: Auth
  if (!options.skipAuth) {
    await stepAuth(options);
  }

  // Step 3: Integrations (skills, MCP, env)
  let skillCount: number | null = null;
  let skillsInstalled = false;
  if (!options.skipSkills) {
    ({ skillCount, skillsInstalled } = await stepIntegrations(options));
  }

  // Step 4: Template
  await stepTemplate();

  // Step 5: Default web provider
  await stepDefaults();

  printNextSteps(
    skillCount,
    true,
    skillsInstalled,
    installFailed ? PACKAGE_MANAGERS[detectPackageManager()].run : 'firecrawl'
  );
  if (installFailed) {
    console.error(
      'Setup incomplete: global CLI installation failed. Other completed steps are preserved.'
    );
    process.exitCode = 1;
  }
}

async function runNonInteractive(options: InitOptions): Promise<void> {
  const failures: string[] = [];
  const steps: string[] = [];
  if (!options.skipAuth) steps.push('auth');
  if (!options.skipInstall) steps.push('install');
  if (!options.skipSkills) steps.push('skills');
  const total = steps.length;
  let current = 0;

  const stepLabel = () => {
    current++;
    return `${bold}[${current}/${total}]${reset}`;
  };

  if (!options.skipAuth) {
    if (options.apiKey) {
      console.log(`${stepLabel()} Authenticating with API key...`);
      try {
        saveCredentials({ apiKey: options.apiKey });
        updateConfig({ apiKey: options.apiKey });
        console.log(`${green}✓${reset} Authenticated\n`);
      } catch (error) {
        console.error(
          'Failed to save credentials:',
          error instanceof Error ? error.message : 'Unknown error'
        );
        process.exit(1);
      }
    } else if (isAuthenticated()) {
      console.log(`${stepLabel()} Authenticating...`);
      console.log(`${green}✓${reset} Already authenticated\n`);
    } else {
      console.log(`${stepLabel()} Authenticating with Firecrawl...`);
      try {
        let result: { apiKey: string; apiUrl?: string; teamName?: string };
        if (options.browser) {
          result = await browserLogin();
        } else {
          result = await interactiveLogin();
        }
        saveCredentials({ apiKey: result.apiKey, apiUrl: result.apiUrl });
        updateConfig({ apiKey: result.apiKey, apiUrl: result.apiUrl });
        const teamSuffix = result.teamName ? ` (Team: ${result.teamName})` : '';
        console.log(`${green}✓${reset} Authenticated${teamSuffix}\n`);
      } catch (error) {
        console.error(
          '\nAuthentication failed:',
          error instanceof Error ? error.message : 'Unknown error'
        );
        failures.push('authentication');
        console.log('You can authenticate later with: firecrawl login\n');
      }
    }
  }

  if (!options.skipInstall) {
    console.log(`${stepLabel()} Installing firecrawl-cli globally...`);
    if (!installGlobalCli()) failures.push('global CLI installation');
  }

  let skillCount: number | null = null;
  let skillsInstalled = false;
  if (!options.skipSkills) {
    console.log(
      `${stepLabel()} Installing firecrawl skills for AI coding agents...`
    );
    for (const selection of [INIT_CLI_SELECTION, INIT_WORKFLOW_SELECTION]) {
      try {
        const count = await installSkillRepoQuiet(selection, options);
        skillsInstalled = true;
        if (count != null) skillCount = (skillCount ?? 0) + count;
      } catch {
        console.error(
          `\n${dim}Failed to install ${selection.label}. Retry with: ${selection.retryCommand}${reset}`
        );
        failures.push(selection.label);
      }
    }
  }

  printNextSteps(
    skillCount,
    false,
    skillsInstalled,
    failures.includes('global CLI installation')
      ? PACKAGE_MANAGERS[detectPackageManager()].run
      : 'firecrawl'
  );
  if (failures.length > 0) {
    console.error(
      `Setup incomplete: ${failures.join(', ')} failed. Other completed steps are preserved.`
    );
    process.exitCode = 1;
  }
}
