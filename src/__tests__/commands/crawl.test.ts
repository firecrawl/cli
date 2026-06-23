/**
 * Tests for crawl command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeCrawl } from '../../commands/crawl';
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
          delay: 1000,
          maxConcurrency: 5,
        }
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
      expect(result).toEqual({
        success: true,
        data: {
          id: mockStatus.id,
          status: mockStatus.status,
          total: mockStatus.total,
          completed: mockStatus.completed,
          creditsUsed: mockStatus.creditsUsed,
          expiresAt: mockStatus.expiresAt,
        },
      });
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
    beforeEach(() => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('should use startCrawl + getCrawlStatus polling when wait flag is set', async () => {
      const jobId = '550e8400-e29b-41d4-a716-446655440000';
      const mockStartResponse = { id: jobId, url: 'https://example.com' };
      const mockCompletedStatus = {
        id: jobId,
        status: 'completed',
        total: 100,
        completed: 100,
        data: [{ markdown: '# Page 1' }],
      };
      mockClient.startCrawl.mockResolvedValue(mockStartResponse);
      mockClient.getCrawlStatus.mockResolvedValue(mockCompletedStatus);

      const crawlPromise = executeCrawl({
        urlOrJobId: 'https://example.com',
        wait: true,
        pollInterval: 0.001,
      });
      await vi.advanceTimersByTimeAsync(1);
      const result = await crawlPromise;

      expect(mockClient.crawl).not.toHaveBeenCalled();
      expect(mockClient.startCrawl).toHaveBeenCalledTimes(1);
      expect(mockClient.startCrawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ pollInterval: 1 })
      );
      expect(mockClient.getCrawlStatus).toHaveBeenCalledWith(jobId);
      expect(result).toEqual({ success: true, data: mockCompletedStatus });
    });

    it('should not write progress to stderr when progress flag is not set', async () => {
      const jobId = '550e8400-e29b-41d4-a716-446655440000';
      mockClient.startCrawl.mockResolvedValue({
        id: jobId,
        url: 'https://example.com',
      });
      mockClient.getCrawlStatus.mockResolvedValue({
        id: jobId,
        status: 'completed',
        total: 10,
        completed: 10,
      });

      const crawlPromise = executeCrawl({
        urlOrJobId: 'https://example.com',
        wait: true,
        pollInterval: 0.001,
      });
      await vi.advanceTimersByTimeAsync(1);
      await crawlPromise;

      expect(process.stderr.write).not.toHaveBeenCalled();
    });

    it('should include custom pollInterval when provided', async () => {
      const jobId = '550e8400-e29b-41d4-a716-446655440000';
      mockClient.startCrawl.mockResolvedValue({
        id: jobId,
        url: 'https://example.com',
      });
      mockClient.getCrawlStatus.mockResolvedValue({
        id: jobId,
        status: 'completed',
        total: 100,
        completed: 100,
      });

      const crawlPromise = executeCrawl({
        urlOrJobId: 'https://example.com',
        wait: true,
        pollInterval: 10,
      });
      await vi.advanceTimersByTimeAsync(10000);
      await crawlPromise;

      expect(mockClient.startCrawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          pollInterval: 10000, // Converted to milliseconds
        })
      );
    });

    it('should include timeout when provided', async () => {
      const jobId = '550e8400-e29b-41d4-a716-446655440000';
      mockClient.startCrawl.mockResolvedValue({
        id: jobId,
        url: 'https://example.com',
      });
      mockClient.getCrawlStatus.mockResolvedValue({
        id: jobId,
        status: 'completed',
        total: 100,
        completed: 100,
      });

      const crawlPromise = executeCrawl({
        urlOrJobId: 'https://example.com',
        wait: true,
        timeout: 300,
        pollInterval: 0.001,
      });
      await vi.advanceTimersByTimeAsync(1);
      await crawlPromise;

      expect(mockClient.startCrawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          timeout: 300000, // Converted to milliseconds
        })
      );
    });

    it('should combine wait options with crawl options', async () => {
      const jobId = '550e8400-e29b-41d4-a716-446655440000';
      mockClient.startCrawl.mockResolvedValue({
        id: jobId,
        url: 'https://example.com',
      });
      mockClient.getCrawlStatus.mockResolvedValue({
        id: jobId,
        status: 'completed',
        total: 50,
        completed: 50,
      });

      const crawlPromise = executeCrawl({
        urlOrJobId: 'https://example.com',
        wait: true,
        pollInterval: 5,
        timeout: 600,
        limit: 50,
        maxDepth: 2,
      });
      await vi.advanceTimersByTimeAsync(5000);
      await crawlPromise;

      expect(mockClient.startCrawl).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          pollInterval: 5000,
          timeout: 600000,
          limit: 50,
          maxDiscoveryDepth: 2,
        })
      );
    });

    it('should return timeout error when crawl exceeds timeout duration', async () => {
      const jobId = '550e8400-e29b-41d4-a716-446655440000';
      mockClient.startCrawl.mockResolvedValue({
        id: jobId,
        url: 'https://example.com',
      });
      // Always return scraping — never completes
      mockClient.getCrawlStatus.mockResolvedValue({
        id: jobId,
        status: 'scraping',
        total: 100,
        completed: 10,
      });

      const crawlPromise = executeCrawl({
        urlOrJobId: 'https://example.com',
        wait: true,
        timeout: 1, // 1 second timeout
        pollInterval: 0.001,
      });
      // Advance past the timeout (1000ms) + one poll interval
      await vi.advanceTimersByTimeAsync(1002);
      const result = await crawlPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout after 1 seconds');
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

    it('should return error result when startCrawl fails in wait mode', async () => {
      const errorMessage = 'Crawl timeout';
      mockClient.startCrawl.mockRejectedValue(new Error(errorMessage));

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
