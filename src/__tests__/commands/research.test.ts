import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSearchPapersCommand } from '../../commands/research';
import { getClient } from '../../utils/client';
import { initializeConfig } from '../../utils/config';
import { writeOutput } from '../../utils/output';
import { setupTest, teardownTest } from '../utils/mock-client';

vi.mock('../../utils/agent-origin', () => ({
  getCliOrigin: () => 'cli.test@1.0.0',
}));

vi.mock('../../utils/credentials', () => ({
  loadCredentials: vi.fn(() => null),
}));

vi.mock('../../utils/output', () => ({ writeOutput: vi.fn() }));

vi.mock('../../utils/client', async () => {
  const actual = await vi.importActual('../../utils/client');
  return {
    ...actual,
    getClient: vi.fn(),
  };
});

describe('handleSearchPapersCommand', () => {
  const names = Array.from({ length: 16 }, (_, i) => `Author ${i + 1}`);
  const response = {
    results: [
      {
        paperId: 'arxiv:1706.03762',
        primaryId: 'arxiv:1706.03762',
        title: 'Attention Is All You Need',
        abstract: 'We propose a new network architecture.',
        authors: ['Ashish Vaswani', 'Noam Shazeer'],
        createdDate: '2017-06-12',
        updateDate: '2017-06-12',
      },
      {
        paperId: 'arxiv:2001.00001',
        primaryId: 'arxiv:2001.00001',
        title: 'A long author list',
        abstract: 'Many authors.',
        authors: names,
      },
      {
        paperId: 'arxiv:2001.00002',
        primaryId: 'arxiv:2001.00002',
        title: 'A comma-joined author string',
        abstract: 'Many authors.',
        authors: names.join(', '),
      },
    ],
  };

  const expectRenderedPapers = () => {
    const [content] = vi.mocked(writeOutput).mock.calls[0];
    expect(content).toContain('Authors: Ashish Vaswani; Noam Shazeer');
    expect(content).toContain('Dates: created 2017-06-12; updated 2017-06-12');
    expect(content).toMatch(/Author 15; et al\.\n/);
    expect(content).toMatch(/Author 15; \+1 more\n/);
    expect(content).not.toContain('Author 16');
  };

  beforeEach(() => {
    setupTest();
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends sort and renders authors and dates with an API key', async () => {
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });
    const mockHttpGet = vi.fn().mockResolvedValue({ data: response });
    vi.mocked(getClient).mockReturnValue({
      http: { get: mockHttpGet },
    } as any);

    await handleSearchPapersCommand({
      query: 'transformer attention',
      sort: 'date_desc',
    });

    expect(mockHttpGet).toHaveBeenCalledWith(
      '/v2/search/research/papers?query=transformer+attention&sort=date_desc&integration=cli&origin=cli.test%401.0.0'
    );
    expectRenderedPapers();
  });

  it('sends sort and renders authors and dates without an API key', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', '');
    initializeConfig({ apiUrl: 'https://api.firecrawl.dev' });
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(response), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await handleSearchPapersCommand({
      query: 'transformer attention',
      sort: 'date_desc',
    });

    expect(getClient).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.firecrawl.dev/v2/search/research/papers?query=transformer+attention&sort=date_desc&integration=cli&origin=cli.test%401.0.0',
      expect.objectContaining({ method: 'GET' })
    );
    expectRenderedPapers();
  });
});
