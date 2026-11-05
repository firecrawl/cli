import { afterEach, expect, it, vi } from 'vitest';
import { requestTerms } from './terms';
vi.mock('../utils/config', () => ({
  getApiKey: () => 'test-key',
  getConfig: () => ({}),
}));
afterEach(() => vi.unstubAllGlobals());
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
