import { afterEach, expect, it, vi } from 'vitest';
import { requestTerms } from '../../commands/terms';

vi.mock('../../utils/config', () => ({
  getApiKey: () => 'fc-test',
  getConfig: () => ({ apiUrl: 'https://api.example.test' }),
}));
afterEach(() => vi.unstubAllGlobals());
const digest = 'a'.repeat(64);

it('presents the selected agreement and points acceptance to the dashboard', async () => {
  const provider = {
    provider: 'particle',
    terms: { version: 'B-1', digest, document: 'Review these terms.' },
  };
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ providers: [provider] }));
  vi.stubGlobal('fetch', fetch);
  const result = await requestTerms('particle', {});
  expect(result).toMatchObject({ success: true, ...provider });
  expect(result.instructions).toContain('organization admin');
  expect(result.instructions).toContain(
    'https://www.firecrawl.dev/app/settings?tab=data-sources'
  );
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://api.example.test/exchange/provider-terms');
  expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
});

it('preserves refusal details and gives actionable guidance without retrying', async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json(
      {
        code: 'forbidden',
        error: 'This endpoint is not enabled for this team.',
      },
      { status: 403 }
    )
  );
  vi.stubGlobal('fetch', fetch);
  const result = await requestTerms('particle', {});
  expect(result).toMatchObject({
    success: false,
    status: 403,
    code: 'forbidden',
    error: 'This endpoint is not enabled for this team.',
    guidance: {
      url: 'https://www.firecrawl.dev/app/settings?tab=data-sources',
    },
  });
  expect(fetch).toHaveBeenCalledOnce();
});
