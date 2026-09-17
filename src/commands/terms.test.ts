import { afterEach, expect, it, vi } from 'vitest';
import { requestTerms } from './terms';
vi.mock('../utils/config', () => ({
  getApiKey: () => 'test-key',
  getConfig: () => ({}),
}));
afterEach(() => vi.unstubAllGlobals());
const options = { termsVersion: 'v1', digest: 'a'.repeat(64), confirm: true };
it('requires explicit confirmation without making any request', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(
    requestTerms('benzinga', { ...options, confirm: false }, true)
  ).rejects.toThrow('--confirm');
  expect(fetcher).not.toHaveBeenCalled();
});
it('submits only the reviewed provider version and digest to the new API', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ success: true, provider: 'benzinga' }))
    );
  vi.stubGlobal('fetch', fetcher);
  expect(await requestTerms('benzinga', options, true)).toMatchObject({
    success: true,
  });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://api.firecrawl.dev/exchange/provider-terms/accept');
  expect(JSON.parse(init.body)).toEqual({
    provider: 'benzinga',
    version: 'v1',
    digest: 'a'.repeat(64),
    confirmed: true,
  });
  expect(init.redirect).toBe('error');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('preserves changed-terms errors without retrying', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'Terms changed', code: 'terms_changed' }),
        { status: 409 }
      )
    );
  vi.stubGlobal('fetch', fetcher);
  expect(await requestTerms('benzinga', options, true)).toMatchObject({
    success: false,
    status: 409,
    code: 'terms_changed',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('shows only the requested provider and rejects HTML responses', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            providers: [{ provider: 'benzinga', terms: { version: 'v1' } }],
          })
        )
      )
      .mockResolvedValueOnce(new Response('<html>'))
  );
  expect(await requestTerms('benzinga', {})).toMatchObject({
    provider: 'benzinga',
    terms: { version: 'v1' },
  });
  await expect(requestTerms('benzinga', {})).rejects.toThrow('non-JSON');
});
