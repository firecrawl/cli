/**
 * Native skill installation — replicates `npx skills add firecrawl/cli --full-depth --global --all`
 * without requiring Node.js or npx. Used as a fallback for binary installs.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  addRouterGuidanceToSkillDescription,
  removeRouterGuidanceFromSkillDescription,
} from '../utils/router-card';

const green = '\x1b[32m';
const dim = '\x1b[2m';
const bold = '\x1b[1m';
const reset = '\x1b[0m';

const DEFAULT_REPO = 'firecrawl/cli';
const SKILLS_SUBDIR = 'skills';

/** Where each agent stores global skills */
interface AgentConfig {
  name: string;
  globalSkillsDir: string;
  /** Directory to check for existence (relative to HOME) */
  detectDir: string;
}

export interface NativeSkillsInstallOptions {
  /** Link skills only into this agent's global skills directory. */
  agent?: string;
  /** Suppress per-repo status lines; caller will render its own summary. */
  quiet?: boolean;
  /** Add the tested router prefix to installed Firecrawl skill descriptions. */
  routerGuidance?: boolean;
}

export interface NativeSkillsInstallResult {
  skillCount: number;
  linkedAgents: string[];
}

/**
 * Per-harness global skills directories.
 *
 * These MUST match the authoritative registry used by the `npx skills` tool
 * (antfu/skills-cli, src/agents.ts) so the native fallback path (no npx) writes
 * to the exact same place npx would. Several dirs are NOT `.<name>/skills`
 * (windsurf, opencode, github-copilot), so relying on the synthesized fallback
 * would install to the wrong directory. Paths are relative to HOME.
 *
 * openclaw/openhands/hermes-agent are Firecrawl launch targets; openclaw and
 * openhands are verified (OpenClaw docs / antfu registry), hermes-agent mirrors
 * its `~/.hermes` config home.
 */
const AGENTS: AgentConfig[] = [
  {
    name: 'claude-code',
    globalSkillsDir: '.claude/skills',
    detectDir: '.claude',
  },
  {
    name: 'cursor',
    globalSkillsDir: '.cursor/skills',
    detectDir: '.cursor',
  },
  {
    // Windsurf stores skills under Codeium, NOT `.windsurf/skills`.
    name: 'windsurf',
    globalSkillsDir: '.codeium/windsurf/skills',
    detectDir: '.codeium/windsurf',
  },
  {
    name: 'codex',
    globalSkillsDir: '.codex/skills',
    detectDir: '.codex',
  },
  {
    name: 'continue',
    globalSkillsDir: '.continue/skills',
    detectDir: '.continue',
  },
  {
    name: 'roo',
    globalSkillsDir: '.roo/skills',
    detectDir: '.roo',
  },
  {
    name: 'gemini-cli',
    globalSkillsDir: '.gemini/skills',
    detectDir: '.gemini',
  },
  {
    // antfu's agent id is 'github-copilot'; global skills live under `.copilot`.
    name: 'github-copilot',
    globalSkillsDir: '.copilot/skills',
    detectDir: '.copilot',
  },
  {
    name: 'droid',
    globalSkillsDir: '.factory/skills',
    detectDir: '.factory',
  },
  {
    // OpenCode stores global skills under `.config/opencode`, NOT `.opencode`.
    name: 'opencode',
    globalSkillsDir: '.config/opencode/skills',
    detectDir: '.config/opencode',
  },
  {
    name: 'openclaw',
    globalSkillsDir: '.openclaw/skills',
    detectDir: '.openclaw',
  },
  {
    name: 'openhands',
    globalSkillsDir: '.openhands/skills',
    detectDir: '.openhands',
  },
  {
    // Launch target's skillsAgent is 'hermes-agent'; its config home is
    // `~/.hermes`, so skills live in `.hermes/skills` (not `.hermes-agent`).
    name: 'hermes-agent',
    globalSkillsDir: '.hermes/skills',
    detectDir: '.hermes',
  },
];

/** Canonical directory for skill files — single source of truth */
const CANONICAL_DIR = '.agents/skills';
const LOCK_FILE = '.agents/.skill-lock.json';

interface SkillEntry {
  /** Skill name from SKILL.md frontmatter */
  name: string;
  /** Path to the skill directory (in temp clone) */
  srcDir: string;
  /** Relative path of SKILL.md within the repo */
  skillPath: string;
}

interface LockEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath: string;
  skillFolderHash: string;
  installedAt: string;
  updatedAt: string;
}

interface LockFile {
  version: number;
  skills: Record<string, LockEntry>;
}

/**
 * Parse SKILL.md frontmatter to extract name and description.
 * Minimal parser — handles `---` delimited YAML frontmatter.
 */
function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: Record<string, string> = {};

  for (const line of yaml.split('\n')) {
    // Handle single-line key: value
    const kv = line.match(/^(\w[\w-]*):\s*(.+)/);
    if (kv) {
      let val = kv[2].trim();
      // Strip surrounding quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      result[kv[1]] = val;
    }
    // Handle multi-line description with |
    const multiline = line.match(/^(\w[\w-]*):\s*\|/);
    if (multiline) {
      result[multiline[1]] = '(multiline)'; // just mark as present
    }
  }

  return { name: result.name, description: result.description };
}

function resolveAgentConfig(agent: string): AgentConfig | undefined {
  const normalized = agent.trim().toLowerCase();
  return AGENTS.find((candidate) => candidate.name === normalized);
}

/**
 * Discover all skills in a directory tree by finding SKILL.md files.
 */
function discoverSkills(baseDir: string): SkillEntry[] {
  const skills: SkillEntry[] = [];
  const seen = new Set<string>();

  function walk(dir: string, depth: number) {
    if (depth > 5) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const skillMd = path.join(fullPath, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          const content = fs.readFileSync(skillMd, 'utf-8');
          const fm = parseFrontmatter(content);
          if (fm.name && fm.description && !seen.has(fm.name)) {
            seen.add(fm.name);
            skills.push({
              name: sanitizeName(fm.name),
              srcDir: fullPath,
              skillPath: path.relative(baseDir, skillMd),
            });
          }
        }
        walk(fullPath, depth + 1);
      }
    }
  }

  walk(baseDir, 0);
  return skills;
}

/** Sanitize skill name: lowercase, replace non-alnum with hyphens */
function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[-.]|[-.]$/g, '')
    .slice(0, 255);
}

/** Recursively copy a directory, filtering out dotfiles and metadata */
function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (
      entry.name.startsWith('.') ||
      entry.name === 'metadata.json' ||
      entry.name === '__pycache__'
    ) {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Compute a simple hash of a directory's contents for the lock file */
function hashDir(dir: string): string {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha1');

  function walk(d: string) {
    for (const entry of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else {
        hash.update(entry.name);
        hash.update(fs.readFileSync(p));
      }
    }
  }

  walk(dir);
  return hash.digest('hex');
}

/**
 * Names of the agents/harnesses whose config directories currently exist under
 * HOME. Used to populate the interactive harness picker in `firecrawl init`.
 */
export function detectInstalledAgentNames(): string[] {
  return detectInstalledAgents().map((agent) => agent.name);
}

/** Detect which agents are installed by checking for their config directories */
function detectInstalledAgents(): AgentConfig[] {
  const home = os.homedir();
  return AGENTS.filter((agent) => {
    const dir = path.join(home, agent.detectDir);
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Check if git is available */
function hasGit(): boolean {
  try {
    execSync('git --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Check if curl or wget is available */
function hasDownloader(): 'curl' | 'wget' | null {
  try {
    execSync('curl --version', { stdio: 'pipe' });
    return 'curl';
  } catch {
    try {
      execSync('wget --version', { stdio: 'pipe' });
      return 'wget';
    } catch {
      return null;
    }
  }
}

/** Clone repo to temp directory */
function cloneRepo(tmpDir: string, repo: string): void {
  const repoUrl = `https://github.com/${repo}.git`;

  if (hasGit()) {
    execSync(`git clone --depth 1 "${repoUrl}" "${tmpDir}"`, {
      stdio: 'pipe',
    });
    return;
  }

  // Fallback: download tarball
  const downloader = hasDownloader();
  if (!downloader) {
    throw new Error('Neither git nor curl/wget found. Cannot download skills.');
  }

  fs.mkdirSync(tmpDir, { recursive: true });
  const tarball = path.join(tmpDir, 'repo.tar.gz');
  const tarballUrl = `https://api.github.com/repos/${repo}/tarball`;

  if (downloader === 'curl') {
    execSync(
      `curl -fsSL -o "${tarball}" -H "Accept: application/vnd.github+json" -L "${tarballUrl}"`,
      { stdio: 'pipe' }
    );
  } else {
    execSync(
      `wget -q -O "${tarball}" --header="Accept: application/vnd.github+json" "${tarballUrl}"`,
      { stdio: 'pipe' }
    );
  }

  execSync(`tar -xzf "${tarball}" -C "${tmpDir}" --strip-components=1`, {
    stdio: 'pipe',
  });
  fs.unlinkSync(tarball);
}

/**
 * Install skills natively — no npx required.
 *
 * Replicates: npx skills add <repo> --full-depth --global --all
 */
export async function installSkillsNative(
  repo: string = DEFAULT_REPO,
  options: NativeSkillsInstallOptions = {}
): Promise<NativeSkillsInstallResult> {
  const home = os.homedir();
  const canonicalBase = path.join(home, CANONICAL_DIR);
  const lockFilePath = path.join(home, LOCK_FILE);
  const repoUrl = `https://github.com/${repo}.git`;

  // Clone repo
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-skills-'));

  try {
    if (!options.quiet) {
      console.log(
        `  ${dim}Downloading skills from github.com/${repo}...${reset}`
      );
    }
    cloneRepo(tmpDir, repo);

    // Discover skills
    const skillsDir = path.join(tmpDir, SKILLS_SUBDIR);
    if (!fs.existsSync(skillsDir)) {
      throw new Error(`No ${SKILLS_SUBDIR}/ directory found in repository`);
    }

    const skills = discoverSkills(skillsDir);
    if (skills.length === 0) {
      throw new Error('No skills found in repository');
    }

    if (!options.quiet) {
      console.log(`  ${dim}Found ${skills.length} skills${reset}`);
    }

    // Copy skills to canonical directory
    fs.mkdirSync(canonicalBase, { recursive: true });

    for (const skill of skills) {
      const destDir = path.join(canonicalBase, skill.name);

      // Remove existing and copy fresh
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true });
      }
      copyDir(skill.srcDir, destDir);
      if (options.routerGuidance) {
        const skillFile = path.join(destDir, 'SKILL.md');
        const content = fs.readFileSync(skillFile, 'utf8');
        fs.writeFileSync(
          skillFile,
          addRouterGuidanceToSkillDescription(content),
          'utf8'
        );
      }
    }

    // Detect installed agents and create symlinks
    const agents = options.agent
      ? [
          resolveAgentConfig(options.agent) ?? {
            name: options.agent,
            globalSkillsDir: path.join(`.${options.agent}`, 'skills'),
            detectDir: `.${options.agent}`,
          },
        ]
      : detectInstalledAgents();
    const linkedAgents: string[] = [];

    for (const agent of agents) {
      const agentSkillsDir = path.join(home, agent.globalSkillsDir);
      fs.mkdirSync(agentSkillsDir, { recursive: true });

      for (const skill of skills) {
        const linkPath = path.join(agentSkillsDir, skill.name);
        const canonicalPath = path.join(canonicalBase, skill.name);

        // Skip if already a correct symlink
        try {
          const existing = fs.readlinkSync(linkPath);
          const expectedTarget = path.relative(
            path.dirname(linkPath),
            canonicalPath
          );
          if (existing === expectedTarget) continue;
        } catch {
          // Not a symlink — remove if exists
        }

        // Remove existing (file, dir, or broken symlink)
        try {
          const stat = fs.lstatSync(linkPath);
          if (stat.isSymbolicLink() || stat.isFile()) {
            fs.unlinkSync(linkPath);
          } else if (stat.isDirectory()) {
            fs.rmSync(linkPath, { recursive: true, force: true });
          }
        } catch {
          // Doesn't exist — fine
        }

        // Create relative symlink
        const relTarget = path.relative(agentSkillsDir, canonicalPath);
        try {
          fs.symlinkSync(relTarget, linkPath);
        } catch {
          // Symlink failed — fall back to copy
          copyDir(canonicalPath, linkPath);
        }
      }

      linkedAgents.push(agent.name);
    }

    // Update lock file
    let lock: LockFile = { version: 3, skills: {} };
    try {
      if (fs.existsSync(lockFilePath)) {
        lock = JSON.parse(fs.readFileSync(lockFilePath, 'utf-8'));
      }
    } catch {
      // Corrupted lock file — start fresh
    }

    const now = new Date().toISOString();
    for (const skill of skills) {
      const canonicalPath = path.join(canonicalBase, skill.name);
      const existing = lock.skills[skill.name];
      lock.skills[skill.name] = {
        source: repo,
        sourceType: 'github',
        sourceUrl: repoUrl,
        skillPath: skill.skillPath,
        skillFolderHash: hashDir(canonicalPath),
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
      };
    }

    fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });
    fs.writeFileSync(lockFilePath, JSON.stringify(lock, null, 2) + '\n');

    // Summary
    if (!options.quiet) {
      console.log(
        `  ${green}✓${reset} ${skills.length} skills installed to ${dim}~/${CANONICAL_DIR}/${reset}`
      );
      if (linkedAgents.length > 0) {
        console.log(
          `  ${green}✓${reset} Linked to: ${linkedAgents.join(', ')}`
        );
      }
    }

    return { skillCount: skills.length, linkedAgents };
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}

/** Remove only Firecrawl's exact router prefix from installed skill files. */
export function removeInstalledRouterGuidance(agent: string): number {
  const home = os.homedir();
  const canonicalRoot = path.join(home, CANONICAL_DIR);
  const roots = [canonicalRoot];
  const agentConfig = resolveAgentConfig(agent);
  if (agentConfig) roots.push(path.join(home, agentConfig.globalSkillsDir));

  const visited = new Set<string>();
  const changedCanonicalSkills = new Set<string>();
  let changed = 0;
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith('firecrawl-')) continue;
      const skillFile = path.join(root, entry.name, 'SKILL.md');
      let identity: string;
      try {
        identity = fs.realpathSync(skillFile);
      } catch {
        continue;
      }
      if (visited.has(identity)) continue;
      visited.add(identity);
      const content = fs.readFileSync(skillFile, 'utf8');
      const updated = removeRouterGuidanceFromSkillDescription(content);
      if (updated === content) continue;
      fs.writeFileSync(skillFile, updated, 'utf8');
      if (root === canonicalRoot) changedCanonicalSkills.add(entry.name);
      changed += 1;
    }
  }

  if (changedCanonicalSkills.size > 0) {
    const lockFilePath = path.join(home, LOCK_FILE);
    try {
      const lock: LockFile = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
      const now = new Date().toISOString();
      for (const skillName of changedCanonicalSkills) {
        const entry = lock.skills?.[skillName];
        const skillDir = path.join(canonicalRoot, skillName);
        if (!entry || !fs.existsSync(skillDir)) continue;
        entry.skillFolderHash = hashDir(skillDir);
        entry.updatedAt = now;
      }
      fs.writeFileSync(lockFilePath, JSON.stringify(lock, null, 2) + '\n');
    } catch {
      // A missing or malformed third-party lock file must not block removal.
    }
  }
  return changed;
}

/** Check if npx is available */
export function hasNpx(): boolean {
  try {
    execSync('npx --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
