import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { colorizeUpdateNotice, formatUpdateBox } from './update-notice-format';
import {
  fetchCatalogTree,
  getCatalogSkills,
  isSkillFile,
  parseCatalogTree,
  type CatalogSkill,
  type SkillFamily,
} from './skill-catalog';

const CHECK_TTL_MS = 20 * 60 * 60 * 1000;
const NOTICE_TTL_MS = 12 * 60 * 60 * 1000;
const RETRY_TTL_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const SKILL_NAME = /^firecrawl(?:-[a-z0-9]+)*$/;
const CHANGES_URL = 'https://github.com/firecrawl/skills/commits/main/';
const SOURCES = new Set([
  'firecrawl/skills',
  'firecrawl/cli',
  'firecrawl/firecrawl-workflows',
  'firecrawl/firecrawl',
]);
const FAMILY_ENTRY: Record<SkillFamily, string> = {
  core: 'firecrawl',
  build: 'firecrawl-build',
  workflows: 'firecrawl-workflows',
};

interface NoticeCache {
  installation?: string;
  checkedAt?: number;
  retryAt?: number;
  tree?: unknown;
  baseline?: string[];
  pendingAdditions?: string[];
  lastShownAt?: number;
}

export interface SkillUpdateNoticeOptions {
  home?: string;
  now?: Date;
  stderr?: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Read native and npx installation state; npx can keep its lock under XDG state. */
async function readInstalledSkills(
  home: string
): Promise<Record<string, { source?: string } | null>> {
  const paths = [path.join(home, '.agents', '.skill-lock.json')];
  if (process.env.XDG_STATE_HOME) {
    paths.push(
      path.join(process.env.XDG_STATE_HOME, 'skills', '.skill-lock.json')
    );
  }
  const skills: Record<string, { source?: string } | null> = {};
  for (const file of paths) {
    const lock = (await readJson(file)) as
      | { skills?: typeof skills }
      | undefined;
    if (
      lock?.skills &&
      typeof lock.skills === 'object' &&
      !Array.isArray(lock.skills)
    ) {
      Object.assign(skills, lock.skills);
    }
  }
  return skills;
}

function cachePathFor(home: string): string {
  return path.join(home, '.firecrawl', 'skill-update-check.json');
}

function readCache(value: unknown): NoticeCache {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as NoticeCache)
    : {};
}

function validNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (name): name is string =>
          typeof name === 'string' && SKILL_NAME.test(name)
      )
    : [];
}

/** Exclusive cache lock; a lock left by a killed process is replaced by one process at a time. */
async function acquireLock(
  file: string
): Promise<(() => Promise<void>) | undefined> {
  const lockPath = `${file}.lock`;
  const takeover = `${lockPath}.takeover`;
  const release = () => fs.rm(lockPath, { recursive: true, force: true });
  const isStale = async (directory: string) => {
    const stat = await fs.stat(directory).catch(() => undefined);
    return stat !== undefined && Date.now() - stat.mtimeMs >= LOCK_STALE_MS;
  };
  try {
    await fs.mkdir(lockPath);
    return release;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!(await isStale(lockPath))) return undefined;
  if (await isStale(takeover)) {
    await fs.rm(takeover, { recursive: true, force: true });
  }
  try {
    await fs.mkdir(takeover);
  } catch {
    return undefined;
  }
  try {
    // Confirm under the takeover lock that nobody replaced the abandoned lock.
    if (!(await isStale(lockPath))) return undefined;
    await fs.rm(lockPath, { recursive: true, force: true });
    await fs.mkdir(lockPath);
    return release;
  } catch {
    return undefined;
  } finally {
    await fs.rm(takeover, { recursive: true, force: true });
  }
}

async function writeCache(file: string, cache: NoticeCache): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(cache) + '\n');
  await fs.rename(temp, file);
}

/** Record the catalog seen at install time so skipped skills are not offered as new. */
export async function rememberCatalogNames(
  names: readonly string[],
  home = os.homedir()
): Promise<void> {
  try {
    const cachePath = cachePathFor(home);
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const release = await acquireLock(cachePath);
    if (!release) return;
    try {
      const cache = readCache(await readJson(cachePath));
      cache.baseline = [
        ...new Set([...validNames(cache.baseline), ...validNames(names)]),
      ].sort();
      await writeCache(cachePath, cache);
    } finally {
      await release().catch(() => {});
    }
  } catch {
    // Recording the baseline is best effort and never fails an install.
  }
}

/** Record a successful npx install, including installs without an explicit skill list. */
export async function rememberSkillInstall(
  repo: string,
  names?: readonly string[],
  family?: SkillFamily
): Promise<void> {
  if (!SOURCES.has(repo)) return;
  if (names) {
    const seen = [...names];
    // Whole-family selections already contain the discovered catalog members.
    if (!family) {
      try {
        const catalog = await getCatalogSkills();
        const families = new Set(
          catalog
            .filter((skill) => names.includes(skill.name))
            .map((skill) => skill.family)
        );
        seen.push(
          ...catalog
            .filter((skill) => families.has(skill.family))
            .map((skill) => skill.name)
        );
      } catch {
        // Catalog outages must not fail an install or lose the selected names.
      }
    }
    return rememberCatalogNames(seen);
  }
  try {
    const skills = await readInstalledSkills(os.homedir());
    await rememberCatalogNames(
      Object.entries(skills)
        .filter(([, entry]) => entry?.source === repo)
        .map(([name]) => name)
    );
  } catch {
    // Missing or malformed installer state never fails a successful install.
  }
}

type InstalledFiles = Record<string, string[]>;

function blobHash(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}

/** Hash local files using Git's blob format so both installer paths are supported. */
async function installedFiles(directory: string): Promise<InstalledFiles> {
  const files: InstalledFiles = {};
  async function walk(relative: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isSkillFile(file)) continue;
      if (entry.isDirectory()) {
        await walk(file);
      } else if (entry.isFile()) {
        const content = await fs.readFile(path.join(directory, file));
        files[file] = [blobHash(content)];
        // Git can check text out with CRLF on Windows without changing its contents.
        if (!content.includes(0) && content.includes('\r\n')) {
          files[file].push(
            blobHash(
              Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'))
            )
          );
        }
      } else {
        throw new Error('Unsupported local skill file.');
      }
    }
  }
  await walk('');
  return files;
}

function sameFiles(
  local: InstalledFiles,
  remote: Record<string, string>
): boolean {
  return (
    Object.keys(local).length === Object.keys(remote).length &&
    Object.entries(remote).every(([file, hash]) => local[file]?.includes(hash))
  );
}

/** Read-only, best-effort notice. It never installs or modifies skill contents. */
export async function maybeShowSkillUpdateNotice(
  options: SkillUpdateNoticeOptions = {}
): Promise<void> {
  const stderr = options.stderr ?? process.stderr;
  if (
    !stderr.isTTY ||
    ['1', 'true'].includes(process.env.FIRECRAWL_NO_UPDATE_CHECK ?? '')
  )
    return;

  let releaseLock: (() => Promise<void>) | undefined;
  try {
    const home = options.home ?? os.homedir();
    const skills = await readInstalledSkills(home);
    const installed = new Map<string, InstalledFiles>();
    for (const [name, entry] of Object.entries(skills)) {
      if (!SKILL_NAME.test(name) || !entry || !SOURCES.has(entry.source ?? ''))
        continue;
      try {
        const files = await installedFiles(
          path.join(home, '.agents', 'skills', name)
        );
        if (Object.hasOwn(files, 'SKILL.md')) installed.set(name, files);
      } catch {
        // Removed or unreadable installations do not need a notice.
      }
    }
    if (!installed.size) return;

    const now = (options.now ?? new Date()).getTime();
    const cachePath = cachePathFor(home);
    // Only one process checks and updates this cache; competing commands stay quiet.
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    releaseLock = await acquireLock(cachePath);
    if (!releaseLock) return;
    const cache = readCache(await readJson(cachePath));
    for (const key of ['checkedAt', 'retryAt', 'lastShownAt'] as const) {
      if (typeof cache[key] !== 'number' || !Number.isFinite(cache[key])) {
        delete cache[key];
      }
    }
    // Skills known before this check: the cached catalog plus names recorded at install.
    const known = validNames(cache.baseline);
    try {
      known.push(...parseCatalogTree(cache.tree).map((skill) => skill.name));
    } catch {
      // No cached catalog yet.
    }
    // With no record yet (an install by an earlier release), every skill missing from
    // a family with its umbrella installed is offered once.
    const previousNames = new Set(known);
    cache.baseline = [...previousNames].sort();
    const installation = createHash('sha256')
      .update(
        JSON.stringify(
          [...installed.keys()].sort().map((name) => [name, skills[name]])
        )
      )
      .digest('hex');
    if (cache.installation !== installation) {
      // A refresh may have installed content newer than our cached catalog.
      delete cache.tree;
      delete cache.checkedAt;
      delete cache.retryAt;
      cache.installation = installation;
    }
    let catalog: CatalogSkill[] | undefined;
    try {
      catalog = parseCatalogTree(cache.tree);
    } catch {
      cache.checkedAt = undefined;
    }
    if (
      (!cache.checkedAt || now - cache.checkedAt > CHECK_TTL_MS) &&
      (!cache.retryAt || now >= cache.retryAt)
    ) {
      try {
        const tree = await fetchCatalogTree(750);
        catalog = parseCatalogTree(tree);
        cache.baseline = [
          ...new Set([...previousNames, ...catalog.map((skill) => skill.name)]),
        ].sort();
        cache.tree = tree;
        cache.checkedAt = now;
        delete cache.retryAt;
      } catch {
        cache.retryAt = now + RETRY_TTL_MS;
      }
    }

    const pendingAdditions = new Set(
      Array.isArray(cache.pendingAdditions) ? cache.pendingAdditions : []
    );
    const changes = (catalog ?? []).filter((skill) => {
      const local = installed.get(skill.name);
      // Missing baseline skills may have been deliberately skipped or removed.
      return local
        ? !sameFiles(local, skill.files)
        : (pendingAdditions.has(skill.name) ||
            !previousNames.has(skill.name)) &&
            installed.has(FAMILY_ENTRY[skill.family]);
    });
    cache.pendingAdditions = changes
      .filter((skill) => !installed.has(skill.name))
      .map((skill) => skill.name);
    if (
      changes.length &&
      (!cache.lastShownAt || now - cache.lastShownAt > NOTICE_TTL_MS)
    ) {
      const title = 'Skill updates available!';
      const lines = [`✨ ${title}`];
      const commands: string[] = [];
      for (const family of ['core', 'build', 'workflows'] as const) {
        if (!changes.some((skill) => skill.family === family)) continue;
        const command = `firecrawl setup ${family}`;
        commands.push(command);
        lines.push(`Run ${command}`);
      }
      lines.push('', 'See latest skill changes:', CHANGES_URL);
      stderr.write(
        `${colorizeUpdateNotice(formatUpdateBox(lines), stderr, {
          title,
          commands,
          url: CHANGES_URL,
        })}\n\n`
      );
      cache.lastShownAt = now;
      delete cache.pendingAdditions;
    } else if (!changes.length) {
      delete cache.lastShownAt;
    }
    await writeCache(cachePath, cache);
  } catch {
    // Offline checks, invalid state and cache permissions never fail a command.
  } finally {
    await releaseLock?.().catch(() => {});
  }
}
