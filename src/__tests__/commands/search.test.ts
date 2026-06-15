/**
 * Tests for search command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSearch } from '../../commands/search';
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

describe('executeSearch', () => {
  let mockClient: any;
  let mockHttpPost: ReturnType<typeof vi.fn>;

  // Wrap a payload in the axios envelope returned by `client.http.post`.
  // Mirrors the `/v2/search` response shape:
  //   { success, data: { web?, news?, images? }, id?, creditsUsed?, warning? }
  const mockSearchResponse = (
    payload: Record<string, any> | any[],
    extras: Record<string, any> = {}
  ) => {
    const inner: Record<string, any> = {
      success: true,
      data: Array.isArray(payload) ? { web: payload } : payload,
      ...extras,
    };
    return { data: inner };
  };

  beforeEach(() => {
    setupTest();
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });

    mockHttpPost = vi.fn();
    mockClient = {
      http: {
        post: mockHttpPost,
      },
    };

    vi.mocked(getClient).mockReturnValue(mockClient as any);
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
  });

  describe('API call generation', () => {
    it('should call /v2/search with correct query and default options', async () => {
      mockHttpPost.mockResolvedValue(
        mockSearchResponse({
          web: [
            {
              url: 'https://example.com',
              title: 'Example',
              description: 'Test',
            },
          ],
        })
      );

      await executeSearch({
        query: 'test query',
      });

      expect(mockHttpPost).toHaveBeenCalledTimes(1);
      expect(mockHttpPost).toHaveBeenCalledWith('/v2/search', {
        query: 'test query',
        limit: undefined,
        integration: 'cli',
      });
    });

    it('should pass apiUrl to getClient when provided', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'test query',
        apiUrl: 'http://localhost:3002',
      });

      expect(getClient).toHaveBeenCalledWith({
        apiKey: undefined,
        apiUrl: 'http://localhost:3002',
      });
    });

    it('should pass both apiKey and apiUrl to getClient when provided', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'test query',
        apiKey: 'fc-custom-key',
        apiUrl: 'http://localhost:3002',
      });

      expect(getClient).toHaveBeenCalledWith({
        apiKey: 'fc-custom-key',
        apiUrl: 'http://localhost:3002',
      });
    });

    it('should include limit option when provided', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'AI news',
        limit: 10,
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'AI news',
          limit: 10,
        })
      );
    });

    it('should include sources option when provided', async () => {
      mockHttpPost.mockResolvedValue(
        mockSearchResponse({ web: [], images: [], news: [] })
      );

      await executeSearch({
        query: 'test query',
        sources: ['web', 'images', 'news'],
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'test query',
          sources: [{ type: 'web' }, { type: 'images' }, { type: 'news' }],
        })
      );
    });

    it('should include single source correctly', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ news: [] }));

      await executeSearch({
        query: 'tech news',
        sources: ['news'],
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'tech news',
          sources: [{ type: 'news' }],
        })
      );
    });

    it('should include categories option when provided', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'web scraping python',
        categories: ['github'],
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'web scraping python',
          categories: [{ type: 'github' }],
        })
      );
    });

    it('should include multiple categories correctly', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'transformer architecture',
        categories: ['research', 'pdf'],
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'transformer architecture',
          categories: [{ type: 'research' }, { type: 'pdf' }],
        })
      );
    });

    it('should include tbs (time-based search) option when provided', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'AI announcements',
        tbs: 'qdr:d', // Past day
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'AI announcements',
          tbs: 'qdr:d',
        })
      );
    });

    it('should include location option when provided', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'restaurants',
        location: 'San Francisco,California,United States',
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'restaurants',
          location: 'San Francisco,California,United States',
        })
      );
    });

    it('should include country option when provided', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'local news',
        country: 'DE',
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'local news',
          country: 'DE',
        })
      );
    });

    it('should include timeout option when provided', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'test query',
        timeout: 30000,
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'test query',
          timeout: 30000,
        })
      );
    });

    it('should include ignoreInvalidUrls option when provided', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'test query',
        ignoreInvalidUrls: true,
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'test query',
          ignoreInvalidURLs: true,
        })
      );
    });

    it('should include scrape options when scrape is enabled', async () => {
      mockHttpPost.mockResolvedValue(
        mockSearchResponse({
          web: [{ url: 'https://example.com', markdown: '# Test' }],
        })
      );

      await executeSearch({
        query: 'firecrawl tutorials',
        scrape: true,
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'firecrawl tutorials',
          scrapeOptions: {
            formats: [{ type: 'markdown' }],
          },
        })
      );
    });

    it('should include custom scrape formats when provided', async () => {
      mockHttpPost.mockResolvedValue(
        mockSearchResponse({
          web: [{ url: 'https://example.com', markdown: '# Test', links: [] }],
        })
      );

      await executeSearch({
        query: 'API docs',
        scrape: true,
        scrapeFormats: ['markdown', 'links'],
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'API docs',
          scrapeOptions: {
            formats: [{ type: 'markdown' }, { type: 'links' }],
          },
        })
      );
    });

    it('should include onlyMainContent in scrape options when provided', async () => {
      mockHttpPost.mockResolvedValue(
        mockSearchResponse({
          web: [{ url: 'https://example.com', markdown: '# Test' }],
        })
      );

      await executeSearch({
        query: 'test query',
        scrape: true,
        onlyMainContent: true,
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({
          query: 'test query',
          scrapeOptions: {
            formats: [{ type: 'markdown' }],
            onlyMainContent: true,
          },
        })
      );
    });

    it('should combine all options correctly', async () => {
      mockHttpPost.mockResolvedValue(
        mockSearchResponse({
          web: [{ url: 'https://example.com', markdown: '# Test' }],
          news: [{ url: 'https://news.example.com', title: 'News' }],
        })
      );

      await executeSearch({
        query: 'comprehensive test',
        limit: 20,
        sources: ['web', 'news'],
        categories: ['github'],
        tbs: 'qdr:w',
        location: 'Germany',
        country: 'DE',
        timeout: 60000,
        scrape: true,
        scrapeFormats: ['markdown', 'links'],
        onlyMainContent: true,
      });

      expect(mockHttpPost).toHaveBeenCalledWith('/v2/search', {
        query: 'comprehensive test',
        limit: 20,
        integration: 'cli',
        sources: [{ type: 'web' }, { type: 'news' }],
        categories: [{ type: 'github' }],
        tbs: 'qdr:w',
        location: 'Germany',
        country: 'DE',
        timeout: 60000,
        scrapeOptions: {
          formats: [{ type: 'markdown' }, { type: 'links' }],
          onlyMainContent: true,
        },
      });
    });
  });

  describe('Response handling', () => {
    it('should return success result with web results', async () => {
      const web = [
        {
          url: 'https://example.com',
          title: 'Example',
          description: 'Test description',
        },
        {
          url: 'https://example2.com',
          title: 'Example 2',
          description: 'Another test',
        },
      ];
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web }));

      const result = await executeSearch({
        query: 'test query',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ web });
    });

    it('should return success result with image results', async () => {
      const images = [
        {
          imageUrl: 'https://example.com/image.jpg',
          url: 'https://example.com',
          title: 'Image 1',
          imageWidth: 800,
          imageHeight: 600,
        },
      ];
      mockHttpPost.mockResolvedValue(mockSearchResponse({ images }));

      const result = await executeSearch({
        query: 'landscapes',
        sources: ['images'],
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ images });
    });

    it('should return success result with news results', async () => {
      const news = [
        {
          url: 'https://news.example.com',
          title: 'Breaking News',
          snippet: 'Something happened',
          date: '2024-01-15',
        },
      ];
      mockHttpPost.mockResolvedValue(mockSearchResponse({ news }));

      const result = await executeSearch({
        query: 'tech news',
        sources: ['news'],
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ news });
    });

    it('should handle combined results from multiple sources', async () => {
      const payload = {
        web: [{ url: 'https://example.com', title: 'Web Result' }],
        images: [
          {
            imageUrl: 'https://example.com/img.jpg',
            url: 'https://example.com',
          },
        ],
        news: [{ url: 'https://news.example.com', title: 'News' }],
      };
      mockHttpPost.mockResolvedValue(mockSearchResponse(payload));

      const result = await executeSearch({
        query: 'machine learning',
        sources: ['web', 'images', 'news'],
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(payload);
    });

    it('should handle response with scraped content', async () => {
      mockHttpPost.mockResolvedValue(
        mockSearchResponse({
          web: [
            {
              url: 'https://example.com',
              title: 'Example',
              markdown: '# Page Content\n\nThis is the content.',
            },
          ],
        })
      );

      const result = await executeSearch({
        query: 'test',
        scrape: true,
      });

      expect(result.success).toBe(true);
      expect(result.data?.web?.[0].markdown).toBe(
        '# Page Content\n\nThis is the content.'
      );
    });

    it('should include warning in result when present', async () => {
      mockHttpPost.mockResolvedValue(
        mockSearchResponse(
          { web: [{ url: 'https://example.com', title: 'Test' }] },
          { warning: 'Some warning message' }
        )
      );

      const result = await executeSearch({
        query: 'test',
      });

      expect(result.success).toBe(true);
      expect(result.warning).toBe('Some warning message');
    });

    it('should include id in result when present', async () => {
      mockHttpPost.mockResolvedValue(
        mockSearchResponse(
          { web: [{ url: 'https://example.com', title: 'Test' }] },
          { id: 'search-123' }
        )
      );

      const result = await executeSearch({
        query: 'test',
      });

      expect(result.success).toBe(true);
      expect(result.id).toBe('search-123');
    });

    it('should include creditsUsed in result when present', async () => {
      mockHttpPost.mockResolvedValue(
        mockSearchResponse(
          { web: [{ url: 'https://example.com', title: 'Test' }] },
          { creditsUsed: 5 }
        )
      );

      const result = await executeSearch({
        query: 'test',
      });

      expect(result.success).toBe(true);
      expect(result.creditsUsed).toBe(5);
    });

    it('should handle empty results', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({}));

      const result = await executeSearch({
        query: 'nonexistent content xyz123',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({});
    });

    it('should return error result when search fails', async () => {
      const errorMessage = 'API Error: Rate limit exceeded';
      mockHttpPost.mockRejectedValue(new Error(errorMessage));

      const result = await executeSearch({
        query: 'test query',
      });

      expect(result).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('should handle non-Error exceptions', async () => {
      mockHttpPost.mockRejectedValue('String error');

      const result = await executeSearch({
        query: 'test query',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error occurred');
    });
  });

  describe('Time-based search parameters', () => {
    it('should support qdr:h for past hour', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'breaking news',
        tbs: 'qdr:h',
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({ tbs: 'qdr:h' })
      );
    });

    it('should support qdr:d for past day', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'AI announcements',
        tbs: 'qdr:d',
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({ tbs: 'qdr:d' })
      );
    });

    it('should support qdr:w for past week', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'tech news',
        tbs: 'qdr:w',
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({ tbs: 'qdr:w' })
      );
    });

    it('should support qdr:m for past month', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'startup funding',
        tbs: 'qdr:m',
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({ tbs: 'qdr:m' })
      );
    });

    it('should support qdr:y for past year', async () => {
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      await executeSearch({
        query: 'yearly review',
        tbs: 'qdr:y',
      });

      expect(mockHttpPost).toHaveBeenCalledWith(
        '/v2/search',
        expect.objectContaining({ tbs: 'qdr:y' })
      );
    });
  });

  describe('Type safety', () => {
    it('should accept valid source types', async () => {
      const sourceList: Array<'web' | 'images' | 'news'> = [
        'web',
        'images',
        'news',
      ];
      mockHttpPost.mockResolvedValue(
        mockSearchResponse({ web: [], images: [], news: [] })
      );

      for (const source of sourceList) {
        const result = await executeSearch({
          query: 'test',
          sources: [source],
        });
        expect(result.success).toBe(true);
      }
    });

    it('should accept valid category types', async () => {
      const categoryList: Array<'github' | 'research' | 'pdf'> = [
        'github',
        'research',
        'pdf',
      ];
      mockHttpPost.mockResolvedValue(mockSearchResponse({ web: [] }));

      for (const category of categoryList) {
        const result = await executeSearch({
          query: 'test',
          categories: [category],
        });
        expect(result.success).toBe(true);
      }
    });

    it('should accept valid scrape format types', async () => {
      const formatList: Array<
        'markdown' | 'html' | 'rawHtml' | 'links' | 'video'
      > = ['markdown', 'html', 'rawHtml', 'links', 'video'];

      for (const format of formatList) {
        mockHttpPost.mockResolvedValue(
          mockSearchResponse({ web: [{ url: 'https://example.com' }] })
        );
        const result = await executeSearch({
          query: 'test',
          scrape: true,
          scrapeFormats: [format],
        });
        expect(result.success).toBe(true);
      }
    });
  });
});
