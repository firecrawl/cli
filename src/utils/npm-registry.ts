/**
 * Lightweight npm registry lookup. Used by `doctor` and the updater to compare
 * the running CLI version against the latest published version. Honors
 * `npm_config_registry` so mirrors and private registries work.
 */

const REGISTRY_URL = 'https://registry.npmjs.org';

export interface LatestVersionResult {
  version?: string;
  /** engines.node declared by that version, if any. */
  nodeRange?: string;
  /** True when the registry could not be reached or returned a non-200. */
  unreachable: boolean;
  error?: string;
}

/**
 * Fetch the `latest` dist-tag for a package. Returns `unreachable: true` on
 * any failure so callers can degrade to a warn instead of a fail. A registry
 * passed in takes precedence over the environment.
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
      engines?: { node?: unknown };
    };
    if (
      typeof data.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(data.version)
    ) {
      return { unreachable: true, error: 'Invalid registry response' };
    }
    const nodeRange = data.engines?.node;
    return {
      version: data.version,
      nodeRange: typeof nodeRange === 'string' ? nodeRange : undefined,
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

/** One comparator such as ">=22" or "^20.10"; undefined when it is not one this reads. */
function satisfiesComparator(
  current: number[],
  comparator: string
): boolean | undefined {
  if (/^[*xX]$/.test(comparator)) return true;
  const match =
    /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(
      comparator
    );
  if (!match) return undefined;
  const [, op = '', ...rest] = match;
  const given = rest.filter((p) => p !== undefined && /^\d+$/.test(p));
  const bound = [0, 1, 2].map((i) => Number(given[i] ?? 0));
  const cmp = compareVersions(current.join('.'), bound.join('.'));
  const sameUpTo = (n: number) =>
    current.slice(0, n).join('.') === bound.slice(0, n).join('.');
  const next = bound.map((part, i) =>
    i < given.length - 1 ? part : i === given.length - 1 ? part + 1 : 0
  );
  const partial = given.length < 3;
  switch (op) {
    case '>=':
      return cmp >= 0;
    case '>':
      return partial
        ? compareVersions(current.join('.'), next.join('.')) >= 0
        : cmp > 0;
    case '<=':
      return partial
        ? compareVersions(current.join('.'), next.join('.')) < 0
        : cmp <= 0;
    case '<':
      return cmp < 0;
    case '^':
      return cmp >= 0 && sameUpTo(1);
    case '~':
      return cmp >= 0 && sameUpTo(Math.min(2, given.length));
    default:
      return sameUpTo(given.length);
  }
}

/**
 * Whether a version satisfies an npm engines range such as ">=22.0.0",
 * "^20.10 || >=22", or "20 - 24". Undefined when the range uses syntax this
 * does not read, so callers can tell "too old" apart from "unknown".
 */
export function satisfiesRange(
  version: string,
  range: string
): boolean | undefined {
  const current = version.replace(/^v/, '').split('.').map(Number);
  let unknown = false;
  for (const alternative of range.split('||')) {
    const comparators = alternative
      .trim()
      .replace(/^(\S+)\s+-\s+(\S+)$/, '>=$1 <=$2')
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
      .split(/\s+/)
      .filter(Boolean);
    const results = comparators.map((c) => satisfiesComparator(current, c));
    if (results.includes(false)) continue;
    if (results.includes(undefined)) unknown = true;
    else return true;
  }
  return unknown ? undefined : false;
}
