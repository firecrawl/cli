/**
 * Tells the user when Alexandria has a structured-data provider for a scraped
 * page's site. The lookup sends only the host and never fails the scrape it
 * accompanies.
 */

import { getApiKey, getConfig } from './config';
import { integrationHeaders } from './integration';

const CLOUD_API_URL = 'https://api.firecrawl.dev';
const LOOKUP_TIMEOUT_MS = 5_000;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

type Lookup = {
  host: string;
  providers: Promise<string[] | undefined>;
  /** Scrapes still waiting on this lookup; the last one to let go of a running lookup aborts it. */
  waiting: number;
  settled: boolean;
  controller: AbortController;
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
 * Starts (or joins) the provider lookup for a URL's host. Returns undefined
 * when no lookup applies: no API key, a self-hosted API, or a non-web URL.
 * Every lookup returned must be passed to `settleSiteProviderHint` or
 * `releaseSiteProviderLookup`.
 */
export function lookupSiteProviders(
  url: string,
  options: { apiKey?: string; apiUrl?: string }
): Lookup | undefined {
  const apiKey = getApiKey(options.apiKey);
  const host = hostOf(url);
  const apiUrl = (
    options.apiUrl ||
    getConfig().apiUrl ||
    CLOUD_API_URL
  ).replace(/\/+$/, '');
  if (!apiKey || !host || apiUrl !== CLOUD_API_URL) return undefined;
  const existing = lookups.get(host);
  if (existing) {
    existing.waiting++;
    return existing;
  }
  const controller = new AbortController();
  const lookup: Lookup = {
    host,
    providers: resolveProviders(host, apiKey, apiUrl, controller.signal),
    waiting: 1,
    settled: false,
    controller,
  };
  void lookup.providers.then(() => {
    lookup.settled = true;
  });
  lookups.set(host, lookup);
  return lookup;
}

/** Stops waiting on a lookup, aborting it when no other scrape still waits on it. */
export function releaseSiteProviderLookup(lookup: Lookup): void {
  lookup.waiting--;
  if (lookup.waiting > 0 || lookup.settled) return;
  lookup.controller.abort();
  lookups.delete(lookup.host);
}

/**
 * Waits at most `waitMs` for a lookup started beside a scrape and returns its
 * hint line, once per host per process.
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
  releaseSiteProviderLookup(lookup);
  if (providers === 'late') return undefined;
  const provider = providers?.[0];
  if (!provider || hinted.has(lookup.host)) return undefined;
  hinted.add(lookup.host);
  return `Alexandria has a structured-data provider for ${lookup.host} (${provider}). For typed records instead of page text, list its tools with \`firecrawl list ${provider}\`, then run one with \`firecrawl scrape ${provider}/<capability> --options '{...}'\`.`;
}

export function resetSiteProviderHints(): void {
  for (const lookup of lookups.values()) lookup.controller.abort();
  lookups.clear();
  hinted.clear();
}
