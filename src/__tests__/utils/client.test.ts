/**
 * Tests for keyless request errors
 *
 * The API links every keyless prompt to signup tagged `utm_medium=api`. The CLI
 * must retag that link as `cli` so signups started from the CLI are attributed
 * to it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  keylessGet,
  keylessRequest,
  withCliSignupTag,
} from '../../utils/client';

const API_LIMIT_MESSAGE = `You've hit Firecrawl's keyless free tier rate limit. To continue now, create a free API key at https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=api

Then authenticate with:
Authorization: Bearer YOUR_API_KEY`;

const CLI_SIGNUP_URL =
  'https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=cli';

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );
}

describe('withCliSignupTag', () => {
  it('retags the keyless signup link as cli', () => {
    const message = withCliSignupTag(API_LIMIT_MESSAGE);

    expect(message).toContain(CLI_SIGNUP_URL);
    expect(message).not.toContain('utm_medium=api');
  });

  it('leaves messages without the keyless signup link unchanged', () => {
    expect(withCliSignupTag('Firecrawl request failed (HTTP 500)')).toBe(
      'Firecrawl request failed (HTTP 500)'
    );
  });
});

describe('keyless requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the keyless limit with the cli signup link', async () => {
    stubFetch(429, { success: false, error: API_LIMIT_MESSAGE });

    await expect(
      keylessRequest('/v2/scrape', { url: 'https://example.com' })
    ).rejects.toThrow(CLI_SIGNUP_URL);
  });

  it('reports the keyless limit on GET requests with the cli signup link', async () => {
    stubFetch(429, { success: false, error: API_LIMIT_MESSAGE });

    await expect(keylessGet('/v2/research/search?q=test')).rejects.toThrow(
      CLI_SIGNUP_URL
    );
  });
});
