/**
 * The `integration` tag sent with API requests. A tool that wraps the CLI can
 * set `FIRECRAWL_INTEGRATION` to a value starting with `_`; anything else
 * falls back to `cli`.
 */
export function getIntegration(): string {
  const tag = process.env.FIRECRAWL_INTEGRATION?.trim();
  return tag?.startsWith('_') ? tag : 'cli';
}
