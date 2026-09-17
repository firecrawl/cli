import { afterEach, expect, it, vi } from 'vitest';
import { requestTerms } from '../../commands/terms';

vi.mock('../../utils/config', () => ({
  getApiKey: () => 'fc-test',
  getConfig: () => ({ apiUrl: 'https://api.example.test' }),
}));
afterEach(() => vi.unstubAllGlobals());
const digest = 'a'.repeat(64);
const options = { termsVersion: 'B-1', digest, confirm: true };

it('presents the selected agreement and requests human approval without accepting', async () => {
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
  expect(result.instructions).toContain('explicit approval');
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][1]).toMatchObject({
    method: 'GET',
    redirect: 'error',
  });
});

it('preserves refusal details and gives actionable guidance without retrying', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
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

it('refuses acceptance without confirmation or the exact version and digest before networking', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const invalid of [
    { ...options, confirm: false },
    { ...options, termsVersion: '' },
    { ...options, digest: 'invalid' },
  ]) {
    await expect(requestTerms('particle', invalid, true)).rejects.toThrow(
      'Review the terms'
    );
  }
  expect(fetch).not.toHaveBeenCalled();
});

it('sends exactly the explicitly confirmed agreement once', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ success: true, receiptId: 'receipt-test' })
    );
  vi.stubGlobal('fetch', fetch);
  expect(await requestTerms('particle', options, true)).toEqual({
    success: true,
    receiptId: 'receipt-test',
  });
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://api.example.test/exchange/provider-terms/accept');
  expect(JSON.parse(init.body)).toEqual({
    provider: 'particle',
    version: 'B-1',
    digest,
    confirmed: true,
  });
});

it('keeps stale agreement failures and never claims acceptance from an ambiguous response', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ code: 'terms_changed', version: 'B-2' }, { status: 409 })
    )
    .mockResolvedValueOnce(Response.json({ receiptId: 'ambiguous' }));
  vi.stubGlobal('fetch', fetch);
  expect(await requestTerms('particle', options, true)).toMatchObject({
    success: false,
    status: 409,
    code: 'terms_changed',
    version: 'B-2',
  });
  await expect(requestTerms('particle', options, true)).rejects.toThrow(
    'did not confirm success'
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
