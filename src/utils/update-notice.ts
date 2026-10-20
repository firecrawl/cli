import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import packageJson from '../../package.json';
import { compareVersions, getLatestVersion } from './npm-registry';
import { colorizeUpdateNotice, formatUpdateBox } from './update-notice-format';

const CACHE_FILENAME = 'update-check.json';
const CACHE_TTL_MS = 20 * 60 * 60 * 1000;
const NOTICE_TTL_MS = 12 * 60 * 60 * 1000;
const RELEASE_NOTES_URL = 'https://github.com/firecrawl/cli/releases/latest';
const NPM_UPDATE_COMMAND = 'npm install -g firecrawl-cli';
const BREW_UPDATE_COMMAND = 'brew upgrade firecrawl-cli';

interface UpdateCache {
  latestVersion: string;
  checkedAt: string;
  lastShownVersion?: string;
  lastShownAt?: string;
}

export interface UpdateNoticeOptions {
  cacheDir?: string;
  installPaths?: string[];
  now?: Date;
  stderr?: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
}

function getCachePath(cacheDir?: string): string {
  return path.join(
    cacheDir ?? path.join(os.homedir(), '.firecrawl'),
    CACHE_FILENAME
  );
}

/**
 * Homebrew installs live under a Cellar keg and must be upgraded with brew.
 * Compiled binaries report a virtual __dirname, so the executable path is checked too.
 */
export function updateCommand(
  installPaths: string[] = [__dirname, process.execPath]
): string {
  return installPaths.some((p) => /[\\/]Cellar[\\/]firecrawl-cli[\\/]/.test(p))
    ? BREW_UPDATE_COMMAND
    : NPM_UPDATE_COMMAND;
}

function updateCheckDisabled(): boolean {
  const value = process.env.FIRECRAWL_NO_UPDATE_CHECK;
  return value === '1' || value === 'true';
}

async function readCachedLatest(
  cachePath: string,
  now: Date
): Promise<{
  latestVersion?: string;
  checkedAt?: string;
  stale: boolean;
  lastShownVersion?: string;
  lastShownAt?: string;
}> {
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UpdateCache>;
    if (
      typeof parsed.latestVersion !== 'string' ||
      typeof parsed.checkedAt !== 'string'
    ) {
      return { stale: true };
    }

    const checkedAt = new Date(parsed.checkedAt).getTime();
    const stale =
      !Number.isFinite(checkedAt) || now.getTime() - checkedAt > CACHE_TTL_MS;
    return {
      latestVersion: parsed.latestVersion,
      checkedAt: parsed.checkedAt,
      stale,
      lastShownVersion: parsed.lastShownVersion,
      lastShownAt: parsed.lastShownAt,
    };
  } catch {
    return { stale: true };
  }
}

async function writeCachedLatest(
  cachePath: string,
  cache: UpdateCache
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, `${JSON.stringify(cache)}\n`, 'utf-8');
  } catch {
    // Update checks should never make a real command fail.
  }
}

export function formatUpdateNotice(
  latestVersion: string,
  command: string = updateCommand()
): string {
  const currentVersion = packageJson.version;
  const lines = [
    `✨ Update available! ${currentVersion} -> ${latestVersion}`,
    `Run ${command} to update.`,
    '',
    'See full release notes:',
    RELEASE_NOTES_URL,
  ];
  return formatUpdateBox(lines);
}

function shouldShowNotice(latestVersion: string | undefined): boolean {
  return (
    typeof latestVersion === 'string' &&
    compareVersions(packageJson.version, latestVersion) < 0
  );
}

function noticeWasRecentlyShown(
  cache: {
    lastShownVersion?: string;
    lastShownAt?: string;
  },
  latestVersion: string,
  now: Date
): boolean {
  if (cache.lastShownVersion !== latestVersion || !cache.lastShownAt) {
    return false;
  }

  const lastShownAt = new Date(cache.lastShownAt).getTime();
  return (
    Number.isFinite(lastShownAt) && now.getTime() - lastShownAt <= NOTICE_TTL_MS
  );
}

export async function maybeShowUpdateNotice(
  options: UpdateNoticeOptions = {}
): Promise<void> {
  const stderr = options.stderr ?? process.stderr;
  if (!stderr.isTTY || updateCheckDisabled()) return;

  const now = options.now ?? new Date();
  const cachePath = getCachePath(options.cacheDir);
  const cached = await readCachedLatest(cachePath, now);

  let latestVersion = cached.latestVersion;
  let checkedAt = cached.checkedAt;
  if (cached.stale) {
    const latest = await getLatestVersion(packageJson.name, 750);
    if (!latest.unreachable && latest.version) {
      latestVersion = latest.version;
      checkedAt = now.toISOString();
      await writeCachedLatest(cachePath, {
        latestVersion: latest.version,
        checkedAt,
        lastShownVersion: cached.lastShownVersion,
        lastShownAt: cached.lastShownAt,
      });
    }
  }

  if (!shouldShowNotice(latestVersion) || latestVersion === undefined) return;
  if (noticeWasRecentlyShown(cached, latestVersion, now)) return;

  const command = updateCommand(options.installPaths);
  stderr.write(
    `${colorizeUpdateNotice(
      formatUpdateNotice(latestVersion, command),
      stderr,
      {
        title: 'Update available!',
        commands: [command],
        url: RELEASE_NOTES_URL,
      }
    )}\n\n`
  );
  await writeCachedLatest(cachePath, {
    latestVersion,
    checkedAt: checkedAt ?? now.toISOString(),
    lastShownVersion: latestVersion,
    lastShownAt: now.toISOString(),
  });
}
