import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleInteractExecute } from '../../commands/interact';
import { initializeConfig } from '../../utils/config';
import { setupTest, teardownTest } from '../utils/mock-client';

vi.mock('../../utils/agent-origin', () => ({
  getCliOrigin: () => 'cli.test@1.0.0',
}));

vi.mock('../../utils/output', () => ({ writeOutput: vi.fn() }));

describe('handleInteractExecute', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setupTest();
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, stdout: 'ok' }),
    });
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    teardownTest();
  });

  it('sends the CLI origin and integration in the request body', async () => {
    await handleInteractExecute({
      scrapeId: 'scrape-1',
      code: 'console.log(1)',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.firecrawl.dev/v2/scrape/scrape-1/interact');
    expect(JSON.parse(init.body as string)).toEqual({
      origin: 'cli.test@1.0.0',
      integration: 'cli',
      code: 'console.log(1)',
      language: 'node',
    });
  });
});
