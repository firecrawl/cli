/**
 * Tests for crawl command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeCrawl, handleCrawlCommand } from '../../commands/crawl';
import { getClient } from '../../utils/client';
import { initializeConfig } from '../../utils/config';
import { setupTest, teardownTest } from '../utils/mock-client';

// Mock the Firecrawl client module
vi.mock('../../utils/client', async () => {
  const actual = await vi.importActual('../../utils/client');
  return {
    ...actual,
    getClient: vi.fn(),
  };
});

describe('executeCrawl', () => {
  let mockClient: any;

  beforeEach(() => {
    setupTest();
    // Initialize config with test API key
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });

    // Create mock client
    mockClient = {
      startCrawl: vi.fn(),
      getCrawlStatus: vi.fn(),
      crawl: vi.fn(),
    };

    // Mock getClient to return our mock
    vi.mocked(getClient).mockReturnValue(mockClient as any);
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
  });

  describe('Start crawl (async)', () => {
    it('should call startCrawl with correct URL and return job ID', async () => {
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        url: 'https://example.com',
      };
      mockClient.startCrawl.mockResolvedValue(mockResponse);

      const result = await executeCrawl({
        urlOrJobId: 'https://example.com',
      });

      expect(mockClient.startCrawl).toHaveBeenCalledTimes(1);
      expect(mockClient.startCrawl).toHaveBeenCalledWith(
        'https://example.com',
        { integration: 'cli' }
      );
      expect(result).toEqual({
        success: true,
        data: {
          jobId: mockResponse.id,
          url: mockResponse.url,
          status: 'processing',
        },
      });
    });

    it('should pass apiUrl to getClient when provided', async () => {
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        url: 'https://example.com',
      };
      mockClient.startCrawl.mockResolvedValue(mockResponse);

      await executeCrawl({
        urlOrJobId: 'https://example.com',
        apiUrl: 'http://localhost:3002',
      });

      expect(getClient).toHaveBeenCalledWith({
        apiKey: undefined,
        apiUrl: 'http://localhost:3002',
      });
    });

    it('should pass both apiKey and apiUrl to getClient when provided', async () => {
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        url: 'https://example.com',
      };
      mockClient.startCrawl.mockResolvedValue(mockResponse);

      await executeCrawl({
        urlOrJobId: 'https://example.com',
        apiKey: 'fc-custom-key',
        apiUrl: 'http://localhost:3002',
      });

      expect(getClient).toHaveBeenCalledWith({
        apiKey: 'fc-custom-key',
        apiUrl: 'http://localhost:3002',
      });
    });

    it('should include limit option when provided', async () => {
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        url: 'https://example.com',
      };
      mockClient.startCrawl.mockResolvedValue(mockResponse);

      await executeCrawl({
        urlOrJobId: 'https://example.com',
        limit: 100,
      });

      expect(mockClient.startCrawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          limit: 100,
        })
      );
    });

    it('should include maxDepth option when provided', async () => {
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        url: 'https://example.com',
      };
      mockClient.startCrawl.mockResolvedValue(mockResponse);

      await executeCrawl({
        urlOrJobId: 'https://example.com',
        maxDepth: 3,
      });

      expect(mockClient.startCrawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          maxDiscoveryDepth: 3,
        })
      );
    });

    it('should include excludePaths option when provided', async () => {
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        url: 'https://example.com',
      };
      mockClient.startCrawl.mockResolvedValue(mockResponse);

      await executeCrawl({
        urlOrJobId: 'https://example.com',
        excludePaths: ['/admin', '/private'],
      });

      expect(mockClient.startCrawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          excludePaths: ['/admin', '/private'],
        })
      );
    });

    it('should include includePaths option when provided', async () => {
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        url: 'https://example.com',
      };
      mockClient.startCrawl.mockResolvedValue(mockResponse);

      await executeCrawl({
        urlOrJobId: 'https://example.com',
        includePaths: ['/blog', '/docs'],
      });

      expect(mockClient.startCrawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          includePaths: ['/blog', '/docs'],
        })
      );
    });

    it('should include sitemap option when provided', async () => {
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        url: 'https://example.com',
      };
      mockClient.startCrawl.mockResolvedValue(mockResponse);

      await executeCrawl({
        urlOrJobId: 'https://example.com',
        sitemap: 'skip',
      });

      expect(mockClient.startCrawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          sitemap: 'skip',
        })
      );
    });

    it('should combine all options correctly', async () => {
      const mockResponse = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        url: 'https://example.com',
      };
      mockClient.startCrawl.mockResolvedValue(mockResponse);

      await executeCrawl({
        urlOrJobId: 'https://example.com',
        limit: 50,
        maxDepth: 2,
        excludePaths: ['/admin'],
        includePaths: ['/blog'],
        sitemap: 'include',
        ignoreQueryParameters: true,
        crawlEntireDomain: false,
        allowExternalLinks: false,
        allowSubdomains: true,
        delay: 1000,
        maxConcurrency: 5,
      });

      expect(mockClient.startCrawl).toHaveBeenCalledWith(
        'https://example.com',
        {
          integration: 'cli',
          limit: 50,
          maxDiscoveryDepth: 2,
          excludePaths: ['/admin'],
          includePaths: ['/blog'],
          sitemap: 'include',
          ignoreQueryParameters: true,
          crawlEntireDomain: false,
          allowExternalLinks: false,
          allowSubdomains: true,
          delay: 1,
          maxConcurrency: 5,
        }
      );
    });

    it('should send --delay to the API in seconds', async () => {
      mockClient.startCrawl.mockResolvedValue({ id: 'job-1', url: '' });

      await executeCrawl({ urlOrJobId: 'https://example.com', delay: 250 });

      expect(mockClient.startCrawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ delay: 0.25 })
      );
    });
  });

  describe('Check crawl status', () => {
    it('should check status when status flag is set', async () => {
      const mockStatus = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'completed',
        total: 100,
        completed: 100,
        creditsUsed: 50,
        expiresAt: '2024-12-31T23:59:59Z',
      };
      mockClient.getCrawlStatus.mockResolvedValue(mockStatus);

      const result = await executeCrawl({
        urlOrJobId: '550e8400-e29b-41d4-a716-446655440000',
        status: true,
      });

      expect(mockClient.getCrawlStatus).toHaveBeenCalledTimes(1);
      expect(mockClient.getCrawlStatus).toHaveBeenCalledWith(
        '550e8400-e29b-41d4-a716-446655440000'
      );
      expect(result).toEqual({ success: true, data: mockStatus });
    });

    it('should return the pages collected so far with the status', async () => {
      const mockStatus = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'completed',
        total: 1,
        completed: 1,
        data: [
          {
            markdown: '# Page',
            metadata: { sourceURL: 'https://example.com' },
          },
        ],
      };
      mockClient.getCrawlStatus.mockResolvedValue(mockStatus);

      const result = await executeCrawl({
        urlOrJobId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(result.success).toBe(true);
      expect(result.data.data).toEqual(mockStatus.data);
    });

    it('should auto-detect job ID from UUID format', async () => {
      const mockStatus = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'scraping',
        total: 100,
        completed: 45,
      };
      mockClient.getCrawlStatus.mockResolvedValue(mockStatus);

      const result = await executeCrawl({
        urlOrJobId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(mockClient.getCrawlStatus).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    it('should handle status check with missing optional fields', async () => {
      const mockStatus = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'scraping',
        total: 100,
        completed: 45,
      };
      mockClient.getCrawlStatus.mockResolvedValue(mockStatus);

      const result = await executeCrawl({
        urlOrJobId: '550e8400-e29b-41d4-a716-446655440000',
        status: true,
      });

      expect(result.success).toBe(true);
      if (result.success && 'data' in result) {
        expect(result.data?.creditsUsed).toBeUndefined();
        expect(result.data?.expiresAt).toBeUndefined();
      }
    });
  });

  describe('Wait mode (synchronous crawl)', () => {
    it('should use crawl method with wait when wait flag is set', async () => {
      const mockCrawlJob = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'completed',
        total: 100,
        completed: 100,
        data: [{ markdown: '# Page 1' }],
      };
      mockClient.crawl.mockResolvedValue(mockCrawlJob);

      const result = await executeCrawl({
        urlOrJobId: 'https://example.com',
        wait: true,
      });

      expect(mockClient.crawl).toHaveBeenCalledTimes(1);
      expect(mockClient.crawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          pollInterval: 5, // SDK waiter expects seconds
        })
      );
      expect(result).toEqual({
        success: true,
        data: mockCrawlJob,
      });
    });

    it('should include custom pollInterval when provided', async () => {
      const mockCrawlJob = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'completed',
        total: 100,
        completed: 100,
        data: [],
      };
      mockClient.crawl.mockResolvedValue(mockCrawlJob);

      await executeCrawl({
        urlOrJobId: 'https://example.com',
        wait: true,
        pollInterval: 10,
      });

      expect(mockClient.crawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          pollInterval: 10,
        })
      );
    });

    it('should include timeout when provided', async () => {
      const mockCrawlJob = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'completed',
        total: 100,
        completed: 100,
        data: [],
      };
      mockClient.crawl.mockResolvedValue(mockCrawlJob);

      await executeCrawl({
        urlOrJobId: 'https://example.com',
        wait: true,
        timeout: 300,
      });

      expect(mockClient.crawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          timeout: 300,
        })
      );
    });

    it('should combine wait options with crawl options', async () => {
      const mockCrawlJob = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        status: 'completed',
        total: 50,
        completed: 50,
        data: [],
      };
      mockClient.crawl.mockResolvedValue(mockCrawlJob);

      await executeCrawl({
        urlOrJobId: 'https://example.com',
        wait: true,
        pollInterval: 5,
        timeout: 600,
        limit: 50,
        maxDepth: 2,
      });

      expect(mockClient.crawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          pollInterval: 5,
          timeout: 600,
          limit: 50,
          maxDiscoveryDepth: 2,
        })
      );
    });
  });

  describe('Resume an existing job', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should poll a job ID to a terminal status with --wait', async () => {
      const jobId = '550e8400-e29b-41d4-a716-446655440000';
      mockClient.getCrawlStatus
        .mockResolvedValueOnce({
          id: jobId,
          status: 'scraping',
          total: 2,
          completed: 1,
          data: [],
        })
        .mockResolvedValueOnce({
          id: jobId,
          status: 'completed',
          total: 2,
          completed: 2,
          data: [{}, {}],
        });

      const crawlPromise = executeCrawl({
        urlOrJobId: jobId,
        wait: true,
        pollInterval: 0.001,
      });
      await vi.advanceTimersByTimeAsync(1);
      const result = await crawlPromise;

      expect(mockClient.startCrawl).not.toHaveBeenCalled();
      expect(mockClient.crawl).not.toHaveBeenCalled();
      expect(mockClient.getCrawlStatus).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        success: true,
        data: {
          id: jobId,
          status: 'completed',
          total: 2,
          completed: 2,
          data: [{}, {}],
        },
      });
    });

    it('should name the resume command when waiting on a job ID times out', async () => {
      const jobId = '550e8400-e29b-41d4-a716-446655440000';
      mockClient.getCrawlStatus.mockResolvedValue({
        id: jobId,
        status: 'scraping',
        total: 2,
        completed: 1,
        data: [],
      });

      const crawlPromise = executeCrawl({
        urlOrJobId: jobId,
        wait: true,
        pollInterval: 1,
        timeout: 1,
      });
      await vi.advanceTimersByTimeAsync(2500);
      const result = await crawlPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain(`firecrawl crawl ${jobId} --wait`);
    });

    it('should poll one status page at a time and fetch every page once the job ends', async () => {
      const jobId = '550e8400-e29b-41d4-a716-446655440000';
      const allPages = {
        id: jobId,
        status: 'completed',
        total: 2,
        completed: 2,
        data: [{}, {}],
      };
      mockClient.getCrawlStatus
        .mockResolvedValueOnce({
          ...allPages,
          data: [{}],
          next: 'https://api.firecrawl.dev/v2/crawl/x?skip=1',
        })
        .mockResolvedValueOnce(allPages);

      const result = await executeCrawl({ urlOrJobId: jobId, wait: true });

      expect(mockClient.getCrawlStatus).toHaveBeenNthCalledWith(1, jobId, {
        autoPaginate: false,
      });
      expect(mockClient.getCrawlStatus).toHaveBeenNthCalledWith(2, jobId);
      expect(result).toEqual({ success: true, data: allPages });
    });

    for (const [flag, options] of [
      ['--poll-interval', { pollInterval: 0 }],
      ['--timeout', { timeout: Number.NaN }],
    ] as const) {
      it(`should reject an invalid ${flag} before polling`, async () => {
        const result = await executeCrawl({
          urlOrJobId: '550e8400-e29b-41d4-a716-446655440000',
          wait: true,
          ...options,
        });

        expect(result).toEqual({
          success: false,
          error: `${flag} must be a positive number of seconds`,
        });
        expect(mockClient.getCrawlStatus).not.toHaveBeenCalled();
      });
    }
  });

  describe('Exit status', () => {
    afterEach(() => {
      process.exitCode = undefined;
      vi.restoreAllMocks();
    });

    for (const status of ['failed', 'cancelled']) {
      it(`should print the job and exit 1 when a waited crawl ends ${status}`, async () => {
        const stdout = vi
          .spyOn(process.stdout, 'write')
          .mockImplementation(() => true);
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
        mockClient.crawl.mockResolvedValue({
          id: 'job-1',
          status,
          total: 1,
          completed: 0,
          data: [],
        });

        await handleCrawlCommand({
          urlOrJobId: 'https://example.com',
          wait: true,
        });

        expect(
          stdout.mock.calls.map(([chunk]) => String(chunk)).join('')
        ).toContain(`"status":"${status}"`);
        expect(stderr).toHaveBeenCalledWith(`Error: Crawl ${status}.`);
        expect(process.exitCode).toBe(1);
      });
    }

    it('should leave the exit status alone when reading a failed job without --wait', async () => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      mockClient.getCrawlStatus.mockResolvedValue({
        id: 'job-1',
        status: 'failed',
        total: 1,
        completed: 0,
        data: [],
      });

      await handleCrawlCommand({
        urlOrJobId: '550e8400-e29b-41d4-a716-446655440000',
      });

      expect(process.exitCode).toBeUndefined();
    });

    it('should leave the exit status alone after a successful cancel with --wait', async () => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      mockClient.cancelCrawl = vi.fn().mockResolvedValue(true);

      await handleCrawlCommand({
        urlOrJobId: '550e8400-e29b-41d4-a716-446655440000',
        cancel: true,
        wait: true,
      });

      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('Progress mode', () => {
    beforeEach(() => {
      // Mock process.stderr.write to avoid console output during tests
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      // Use fake timers to avoid actual waiting
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('should use custom polling with progress when progress flag is set', async () => {
      const jobId = '550e8400-e29b-41d4-a716-446655440000';
      const mockStartResponse = {
        id: jobId,
        url: 'https://example.com',
      };
      const mockScrapingStatus = {
        id: jobId,
        status: 'scraping',
        total: 100,
        completed: 50,
        data: [],
      };
      const mockCompletedStatus = {
        id: jobId,
        status: 'completed',
        total: 100,
        completed: 100,
        data: [],
      };

      mockClient.startCrawl.mockResolvedValue(mockStartResponse);
      // First call returns scraping status, second returns completed
      mockClient.getCrawlStatus
        .mockResolvedValueOnce(mockScrapingStatus)
        .mockResolvedValueOnce(mockCompletedStatus);

      // Start the async operation
      const crawlPromise = executeCrawl({
        urlOrJobId: 'https://example.com',
        wait: true,
        progress: true,
        pollInterval: 0.001, // Very short interval for testing (1ms)
      });

      // Fast-forward timers to resolve the first setTimeout
      await vi.advanceTimersByTimeAsync(1);

      // Fast-forward again to resolve the second setTimeout
      await vi.advanceTimersByTimeAsync(1);

      const result = await crawlPromise;

      expect(mockClient.startCrawl).toHaveBeenCalledTimes(1);
      const [, startOptions] = mockClient.startCrawl.mock.calls[0];
      expect(startOptions).not.toHaveProperty('pollInterval');
      expect(startOptions).not.toHaveProperty('timeout');
      expect(mockClient.getCrawlStatus).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
      if (result.success && 'data' in result) {
        expect(result.data.status).toBe('completed');
      }
    });
  });

  describe('Error handling', () => {
    it('should return error result when startCrawl fails', async () => {
      const errorMessage = 'API Error: Invalid URL';
      mockClient.startCrawl.mockRejectedValue(new Error(errorMessage));

      const result = await executeCrawl({
        urlOrJobId: 'https://example.com',
      });

      expect(result).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('should return error result when getCrawlStatus fails', async () => {
      const errorMessage = 'Job not found';
      mockClient.getCrawlStatus.mockRejectedValue(new Error(errorMessage));

      const result = await executeCrawl({
        urlOrJobId: '550e8400-e29b-41d4-a716-446655440000',
        status: true,
      });

      expect(result).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('should return error result when crawl fails', async () => {
      const errorMessage = 'Crawl timeout';
      mockClient.crawl.mockRejectedValue(new Error(errorMessage));

      const result = await executeCrawl({
        urlOrJobId: 'https://example.com',
        wait: true,
      });

      expect(result).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('should handle non-Error exceptions', async () => {
      mockClient.startCrawl.mockRejectedValue('String error');

      const result = await executeCrawl({
        urlOrJobId: 'https://example.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error occurred');
    });
  });
});
