/**
 * Tests for keyless request errors
 *
 * The API links every keyless prompt to the caller's own opaque signup link,
 * https://firecrawl.dev/k/<id>, which the site resolves to CLI attribution when
 * the request came from the CLI. The CLI prints that link unchanged and tells
 * the API it is the CLI with X-Origin, including on requests without a body.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { keylessGet, keylessRequest } from '../../utils/client';

const OWN_SIGNUP_URL = 'https://firecrawl.dev/k/7fq2xab9';

const API_LIMIT_MESSAGE = `You've hit Firecrawl's keyless free tier rate limit. To continue now, create a free API key at ${OWN_SIGNUP_URL}

Then authenticate with:
Authorization: Bearer YOUR_API_KEY`;

// Before the /k links, the API sent a UTM-tagged link. An API still sending it
// must not be rewritten into something else.
const LEGACY_LIMIT_MESSAGE =
  "You've hit Firecrawl's keyless free tier rate limit. To continue now, create a free API key at https://www.firecrawl.dev/signin?utm_source=keyless&utm_medium=api";

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('keyless requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the keyless limit with the API-issued signup link unchanged', async () => {
    stubFetch(429, {
      success: false,
      error: API_LIMIT_MESSAGE,
      signup_url: OWN_SIGNUP_URL,
    });

    await expect(
      keylessRequest('/v2/scrape', { url: 'https://example.com' })
    ).rejects.toThrow(API_LIMIT_MESSAGE);
  });

  it('reports the keyless limit on GET requests with the API-issued link', async () => {
    stubFetch(429, { success: false, error: API_LIMIT_MESSAGE });

    await expect(keylessGet('/v2/research/search?q=test')).rejects.toThrow(
      OWN_SIGNUP_URL
    );
  });

  it('no longer rewrites a legacy UTM link', async () => {
    stubFetch(429, { success: false, error: LEGACY_LIMIT_MESSAGE });

    await expect(
      keylessRequest('/v2/scrape', { url: 'https://example.com' })
    ).rejects.toThrow(LEGACY_LIMIT_MESSAGE);
  });

  it.each([false, true])(
    'preserves failed-job invitations with nested metadata: %s',
    async (nested) => {
      const metadata = { jobId: 'job-1', feedback: { jobId: 'job-1' } };
      stubFetch(200, {
        success: false,
        error: 'Scrape failed',
        ...(nested ? { data: { metadata } } : { metadata }),
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        await expect(keylessRequest('/v2/scrape', {})).rejects.toThrow(
          'Scrape failed'
        );
        expect(stderr.mock.calls.flat().join('')).toContain(
          'firecrawl feedback scrape job-1 --help'
        );
      } finally {
        stderr.mockRestore();
      }
    }
  );

  it('identifies the CLI with X-Origin on POST and GET requests', async () => {
    const fetchMock = stubFetch(200, { success: true });

    await keylessRequest('/v2/scrape', { url: 'https://example.com' });
    await keylessGet('/v2/research/search?q=test');

    for (const [, init] of fetchMock.mock.calls) {
      const headers = init?.headers as Record<string, string>;
      expect(headers['X-Origin']).toBe('cli');
      expect(headers.Authorization).toBeUndefined();
    }
  });
});
