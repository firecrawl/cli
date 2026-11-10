/**
 * Tells the user when Alexandria has a structured-data provider for a scraped
 * page's site. The lookup sends only the host and never fails the scrape it
 * accompanies.
 */

import { getApiKey, getConfig, isCustomApiUrl } from './config';
import { integrationHeaders } from './integration';

const LOOKUP_TIMEOUT_MS = 5_000;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

type Lookup = {
  host: string;
  providers: Promise<string[] | undefined>;
  /** Stops a lookup still running, so it never keeps the process alive. */
  abort(): void;
};

const lookups = new Map<string, Lookup>();
const hinted = new Set<string>();

function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    return parsed.hostname.toLowerCase().replace(/\.$/, '') || undefined;
  } catch {
    return undefined;
  }
}

async function resolveProviders(
  host: string,
  apiKey: string,
  apiUrl: string,
  signal: AbortSignal
): Promise<string[] | undefined> {
  try {
    const response = await fetch(
      `${apiUrl.replace(/\/$/, '')}/exchange/skills/resolve`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...integrationHeaders(),
        },
        body: JSON.stringify({ urls: [`https://${host}/`] }),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        ]),
        redirect: 'error',
      }
    );
    if (!response.ok) return undefined;
    const body: any = await response.json();
    if (!Array.isArray(body?.skills)) return undefined;
    return [
      ...new Set<string>(
        body.skills
          .map((skill: any) => skill?.id)
          .filter(
            (id: unknown): id is string =>
              typeof id === 'string' && PROVIDER_ID.test(id)
          )
      ),
    ];
  } catch {
    return undefined;
  }
}

/**
 * Starts (or reuses) the provider lookup for a URL's host. Returns undefined
 * when no lookup applies: no API key, a self-hosted API, or a non-web URL.
 */
export function lookupSiteProviders(
  url: string,
  options: { apiKey?: string; apiUrl?: string }
): Lookup | undefined {
  const apiKey = getApiKey(options.apiKey);
  const host = hostOf(url);
  if (!apiKey || !host || isCustomApiUrl(options.apiUrl)) return undefined;
  const existing = lookups.get(host);
  if (existing) return existing;
  const controller = new AbortController();
  const lookup: Lookup = {
    host,
    providers: resolveProviders(
      host,
      apiKey,
      options.apiUrl || getConfig().apiUrl || 'https://api.firecrawl.dev',
      controller.signal
    ),
    abort: () => controller.abort(),
  };
  lookups.set(host, lookup);
  return lookup;
}

/**
 * Waits at most `waitMs` for a lookup started beside a scrape and returns its
 * hint line, once per host per process. A late lookup is aborted.
 */
export async function settleSiteProviderHint(
  lookup: Lookup,
  waitMs: number
): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), waitMs);
  });
  const providers = await Promise.race([lookup.providers, late]);
  clearTimeout(timer);
  if (providers === 'late') {
    lookup.abort();
    return undefined;
  }
  const provider = providers?.[0];
  if (!provider || hinted.has(lookup.host)) return undefined;
  hinted.add(lookup.host);
  return `Alexandria has a structured-data provider for ${lookup.host} (${provider}). For typed records instead of page text, list its tools with \`firecrawl list ${provider}\`, then run one with \`firecrawl scrape ${provider}/<capability> --options '{...}'\`.`;
}

export function resetSiteProviderHints(): void {
  for (const lookup of lookups.values()) lookup.abort();
  lookups.clear();
  hinted.clear();
}
