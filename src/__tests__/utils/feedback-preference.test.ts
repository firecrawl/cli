import { afterEach, expect, it, vi } from 'vitest';
import { keylessRequest } from '../../utils/client';

vi.mock('../../utils/config', () => ({
  getConfig: () => ({ apiUrl: 'https://example.test' }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(['/v2/search', '/v2/scrape'])(
  'does not send an invitation opt-out for keyless %s',
  async (path) => {
    vi.stubEnv('FIRECRAWL_DISABLE_ENDPOINT_FEEDBACK', 'true');
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetch);
    expect(await keylessRequest(path, { example: 'fixture' })).toEqual({
      success: true,
    });
    expect(fetch.mock.calls[0][1]).toMatchObject({
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ example: 'fixture' }),
    });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(
      fetch.mock.calls[0][1].headers['x-firecrawl-no-feedback']
    ).toBeUndefined();
  }
);
