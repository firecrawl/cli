import type { Firecrawl } from 'firecrawl';

/**
 * FIRECRAWL_INTEGRATION as an X-Integration header, for every API request.
 * The API ignores a value it does not recognize, so the CLI keeps no list; it
 * only drops values that cannot be sent as a header at all.
 */
export function integrationHeaders(): Record<string, string> {
  const tag = process.env.FIRECRAWL_INTEGRATION?.trim();
  return tag && /^[\x20-\x7e]+$/.test(tag) ? { 'X-Integration': tag } : {};
}

/** Adds the integration header to every request an SDK client sends. */
export function withIntegrationHeader<T extends Firecrawl>(client: T): T {
  const defaults = (
    client as unknown as {
      http?: {
        instance?: { defaults?: { headers?: Record<string, unknown> } };
      };
    }
  ).http?.instance?.defaults?.headers;
  if (defaults) Object.assign(defaults, integrationHeaders());
  return client;
}
