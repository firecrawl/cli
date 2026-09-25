import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keylessGet, keylessRequest } from '../../utils/client';
import { initializeConfig, resetConfig } from '../../utils/config';

vi.mock('../../utils/credentials', () => ({
  loadCredentials: vi.fn(() => null),
}));

describe('keyless requests', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetConfig();
    initializeConfig({ apiUrl: 'https://api.firecrawl.dev///' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ success: true }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetConfig();
  });

  it('joins POST paths after every trailing slash is removed', async () => {
    await keylessRequest('/v2/scrape', { url: 'https://example.com' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.firecrawl.dev/v2/scrape',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('joins GET paths after every trailing slash is removed', async () => {
    await keylessGet('/v2/search/research');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.firecrawl.dev/v2/search/research',
      expect.objectContaining({ method: 'GET' })
    );
  });
});
