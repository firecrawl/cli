import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  executeEndpointFeedback,
  handleEndpointFeedbackCommand,
  parseEndpointFeedbackEndpoint,
  parseFeedbackListArg,
  parsePageNumbersArg,
} from '../../commands/feedback';
import { getClient } from '../../utils/client';
import { initializeConfig } from '../../utils/config';
import { setupTest, teardownTest } from '../utils/mock-client';

vi.mock('../../utils/client', async () => {
  const actual = await vi.importActual('../../utils/client');
  return {
    ...actual,
    getClient: vi.fn(),
  };
});

describe('executeEndpointFeedback', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setupTest();
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });

    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
    delete process.env.FIRECRAWL_NO_ENDPOINT_FEEDBACK;
    delete process.env.FIRECRAWL_DISABLE_ENDPOINT_FEEDBACK;
  });

  it('posts generic endpoint feedback to /v2/feedback', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        success: true,
        feedbackId: '0193f6c5-1234-7890-abcd-1234567890ab',
        creditsRefunded: 1,
      }),
    });

    const result = await executeEndpointFeedback({
      endpoint: 'scrape',
      jobId: '0193f6c5-1234-7890-abcd-1234567890ab',
      rating: 'partial',
      issues: ['missing_markdown'],
      tags: ['docs'],
      note: 'The markdown missed the pricing table.',
      url: 'https://example.com/pricing',
      pageNumbers: [1, 2],
      metadata: { source: 'test' },
      apiUrl: 'http://localhost:3002',
    });

    expect(getClient).toHaveBeenCalledWith({
      apiKey: undefined,
      apiUrl: 'http://localhost:3002',
    });
    expect(result).toEqual({
      success: true,
      feedbackId: '0193f6c5-1234-7890-abcd-1234567890ab',
      creditsRefunded: 1,
      creditsRefundedToday: undefined,
      dailyRefundCap: undefined,
      dailyCapReached: false,
      alreadySubmitted: undefined,
      warning: undefined,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3002/v2/feedback',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
          'Content-Type': 'application/json',
        }),
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      endpoint: 'scrape',
      jobId: '0193f6c5-1234-7890-abcd-1234567890ab',
      rating: 'partial',
      origin: 'cli',
      integration: 'cli',
      issues: ['missing_markdown'],
      tags: ['docs'],
      note: 'The markdown missed the pricing table.',
      url: 'https://example.com/pricing',
      pageNumbers: [1, 2],
      metadata: { source: 'test' },
    });
  });

  it('treats team opt-out as a disabled success', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({
        success: false,
        error: 'Feedback is disabled for this team.',
        feedbackErrorCode: 'TEAM_OPTED_OUT',
      }),
    });

    await expect(
      executeEndpointFeedback({
        endpoint: 'map',
        jobId: '0193f6c5-1234-7890-abcd-1234567890ab',
        rating: 'bad',
        issues: ['missing_links'],
      })
    ).resolves.toMatchObject({
      success: true,
      disabled: true,
      disabledSource: 'team',
      creditsRefunded: 0,
    });
  });

  it('skips endpoint feedback when local opt-out is set', async () => {
    process.env.FIRECRAWL_NO_ENDPOINT_FEEDBACK = '1';

    await expect(
      executeEndpointFeedback({
        endpoint: 'scrape',
        jobId: '0193f6c5-1234-7890-abcd-1234567890ab',
        rating: 'bad',
        issues: ['missing_markdown'],
      })
    ).resolves.toMatchObject({
      success: true,
      disabled: true,
      disabledSource: 'env',
      creditsRefunded: 0,
    });

    expect(getClient).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('handles local opt-out silently in the CLI command path', async () => {
    process.env.FIRECRAWL_NO_ENDPOINT_FEEDBACK = '1';

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: number | string | null
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as typeof process.exit);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      await expect(
        handleEndpointFeedbackCommand({
          endpoint: 'scrape',
          jobId: '0193f6c5-1234-7890-abcd-1234567890ab',
          rating: 'bad',
          issues: ['missing_markdown'],
        })
      ).rejects.toThrow('process.exit:0');

      expect(stderrSpy).not.toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(getClient).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });
});

describe('feedback parsing', () => {
  it('parses endpoint names', () => {
    expect(parseEndpointFeedbackEndpoint('Scrape')).toBe('scrape');
    expect(() => parseEndpointFeedbackEndpoint('crawl')).toThrow(
      'endpoint must be one of'
    );
  });

  it('parses comma-separated and JSON list options', () => {
    expect(
      parseFeedbackListArg('missing_markdown, bad_pdf', '--issues')
    ).toEqual(['missing_markdown', 'bad_pdf']);
    expect(parseFeedbackListArg('["a","b"]', '--tags')).toEqual(['a', 'b']);
  });

  it('parses positive page numbers', () => {
    expect(parsePageNumbersArg('1, 2, bad, -1, 3')).toEqual([1, 2, 3]);
    expect(parsePageNumbersArg('[4,5]')).toEqual([4, 5]);
  });
});
