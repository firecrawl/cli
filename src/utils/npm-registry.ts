/**
 * Lightweight npm registry lookup. Used by `doctor` and the updater to compare
 * the running CLI version against the latest published version. Honors
 * `npm_config_registry` so mirrors and private registries work.
 */

const REGISTRY_URL = 'https://registry.npmjs.org';

export interface LatestVersionResult {
  version?: string;
  /** True when the registry could not be reached or returned a non-200. */
  unreachable: boolean;
  error?: string;
}

/**
 * Fetch the `latest` dist-tag for a package. Returns `unreachable: true` on
 * any failure so callers can degrade to a warn instead of a fail.
 */
export async function getLatestVersion(
  packageName: string,
  timeoutMs = 2000,
  configuredRegistry?: string
): Promise<LatestVersionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const registry = (
      configuredRegistry ||
      process.env.npm_config_registry ||
      process.env.NPM_CONFIG_REGISTRY ||
      REGISTRY_URL
    ).replace(/\/+$/, '');
    const response = await fetch(`${registry}/${packageName}/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return {
        unreachable: true,
        error: `HTTP ${response.status}`,
      };
    }

    const data = (await response.json()) as {
      version?: string;
    };
    if (
      typeof data.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(data.version)
    ) {
      return { unreachable: true, error: 'Invalid registry response' };
    }
    return {
      version: data.version,
      unreachable: false,
    };
  } catch (error) {
    return {
      unreachable: true,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** When the registry says a release was published, or undefined if it does not say. */
export async function getPublishTime(
  packageName: string,
  version: string,
  registry: string,
  timeoutMs = 30_000
): Promise<number | undefined> {
  const response = await fetch(
    `${registry.replace(/\/+$/, '')}/${packageName}`,
    {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    }
  );
  if (!response.ok)
    throw new Error(`Registry request failed: HTTP ${response.status}`);
  const data = (await response.json()) as { time?: Record<string, unknown> };
  const published = data.time?.[version];
  if (published === undefined) return undefined;
  const time = typeof published === 'string' ? Date.parse(published) : NaN;
  if (!Number.isFinite(time))
    throw new Error(`Invalid publish time for ${version}`);
  return time;
}

/**
 * Compare two semver-like version strings. Returns:
 *  - negative if a < b
 *  - 0       if a === b
 *  - positive if a > b
 *
 * Only the numeric major.minor.patch is considered; pre-release suffixes are
 * dropped. Good enough for "is there a newer release on npm" — not a general
 * semver implementation.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const stripped = v.replace(/^v/, '').split(/[-+]/)[0];
    return stripped.split('.').map((part) => {
      const n = parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  };

  const aParts = parse(a);
  const bParts = parse(b);
  const length = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < length; i++) {
    const ai = aParts[i] ?? 0;
    const bi = bParts[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

export function isPrerelease(version: string): boolean {
  return /^v?\d+\.\d+\.\d+-/.test(version);
}
