/**
 * Tests for map command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeMap } from '../../commands/map';
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

describe('executeMap', () => {
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
      map: vi.fn(),
    };

    // Mock getClient to return our mock
    vi.mocked(getClient).mockReturnValue(mockClient as any);
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
  });

  describe('API call generation', () => {
    it('should call map with correct URL and default options', async () => {
      const mockResponse = {
        links: [
          { url: 'https://example.com/page1', title: 'Page 1' },
          { url: 'https://example.com/page2', title: 'Page 2' },
        ],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      await executeMap({
        urlOrJobId: 'https://example.com',
      });

      expect(mockClient.map).toHaveBeenCalledTimes(1);
      expect(mockClient.map).toHaveBeenCalledWith('https://example.com', {});
    });

    it('should pass apiUrl to getClient when provided', async () => {
      const mockResponse = {
        links: [{ url: 'https://example.com/page1' }],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      await executeMap({
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
        links: [{ url: 'https://example.com/page1' }],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      await executeMap({
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
        links: [{ url: 'https://example.com/page1' }],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      await executeMap({
        urlOrJobId: 'https://example.com',
        limit: 50,
      });

      expect(mockClient.map).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          limit: 50,
        })
      );
    });

    it('should include search option when provided', async () => {
      const mockResponse = {
        links: [{ url: 'https://example.com/blog' }],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      await executeMap({
        urlOrJobId: 'https://example.com',
        search: 'blog',
      });

      expect(mockClient.map).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          search: 'blog',
        })
      );
    });

    it('should include sitemap option when provided', async () => {
      const mockResponse = {
        links: [{ url: 'https://example.com/page1' }],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      await executeMap({
        urlOrJobId: 'https://example.com',
        sitemap: 'only',
      });

      expect(mockClient.map).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          sitemap: 'only',
        })
      );
    });

    it('should include includeSubdomains option when provided', async () => {
      const mockResponse = {
        links: [{ url: 'https://sub.example.com/page1' }],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      await executeMap({
        urlOrJobId: 'https://example.com',
        includeSubdomains: true,
      });

      expect(mockClient.map).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          includeSubdomains: true,
        })
      );
    });

    it('should include ignoreQueryParameters option when provided', async () => {
      const mockResponse = {
        links: [{ url: 'https://example.com/page1' }],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      await executeMap({
        urlOrJobId: 'https://example.com',
        ignoreQueryParameters: true,
      });

      expect(mockClient.map).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          ignoreQueryParameters: true,
        })
      );
    });

    it('should include timeout option when provided', async () => {
      const mockResponse = {
        links: [{ url: 'https://example.com/page1' }],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      await executeMap({
        urlOrJobId: 'https://example.com',
        timeout: 60,
      });

      expect(mockClient.map).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({
          timeout: 60000, // Converted to milliseconds
        })
      );
    });

    it('should combine all options correctly', async () => {
      const mockResponse = {
        links: [
          { url: 'https://example.com/blog/post1' },
          { url: 'https://example.com/blog/post2' },
        ],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      await executeMap({
        urlOrJobId: 'https://example.com',
        limit: 100,
        search: 'blog',
        sitemap: 'include',
        includeSubdomains: true,
        ignoreQueryParameters: true,
        timeout: 120,
      });

      expect(mockClient.map).toHaveBeenCalledWith('https://example.com', {
        limit: 100,
        search: 'blog',
        sitemap: 'include',
        includeSubdomains: true,
        ignoreQueryParameters: true,
        timeout: 120000,
      });
    });
  });

  describe('Response handling', () => {
    it('should return success result with mapped links', async () => {
      const mockResponse = {
        links: [
          {
            url: 'https://example.com/page1',
            title: 'Page 1',
            description: 'Description 1',
          },
          {
            url: 'https://example.com/page2',
            title: 'Page 2',
            description: 'Description 2',
          },
        ],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      const result = await executeMap({
        urlOrJobId: 'https://example.com',
      });

      expect(result).toEqual({
        success: true,
        data: {
          links: [
            {
              url: 'https://example.com/page1',
              title: 'Page 1',
              description: 'Description 1',
            },
            {
              url: 'https://example.com/page2',
              title: 'Page 2',
              description: 'Description 2',
            },
          ],
        },
      });
    });

    it('should handle links without title or description', async () => {
      const mockResponse = {
        links: [
          { url: 'https://example.com/page1' },
          {
            url: 'https://example.com/page2',
            title: 'Page 2',
          },
        ],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      const result = await executeMap({
        urlOrJobId: 'https://example.com',
      });

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.links).toHaveLength(2);
        expect(result.data.links[0]).toEqual({
          url: 'https://example.com/page1',
          title: undefined,
          description: undefined,
        });
        expect(result.data.links[1]).toEqual({
          url: 'https://example.com/page2',
          title: 'Page 2',
          description: undefined,
        });
      }
    });

    it('should handle empty links array', async () => {
      const mockResponse = {
        links: [],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      const result = await executeMap({
        urlOrJobId: 'https://example.com',
      });

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.links).toEqual([]);
      }
    });

    it('should return error result when map fails', async () => {
      const errorMessage = 'API Error: Invalid URL';
      mockClient.map.mockRejectedValue(new Error(errorMessage));

      const result = await executeMap({
        urlOrJobId: 'https://example.com',
      });

      expect(result).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('should handle non-Error exceptions', async () => {
      mockClient.map.mockRejectedValue('String error');

      const result = await executeMap({
        urlOrJobId: 'https://example.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error occurred');
    });
  });

  describe('Data transformation', () => {
    it('should transform links to expected format', async () => {
      const mockResponse = {
        links: [
          {
            url: 'https://example.com/page1',
            title: 'Page 1',
            description: 'Description 1',
            otherField: 'should be ignored',
          },
        ],
      };
      mockClient.map.mockResolvedValue(mockResponse);

      const result = await executeMap({
        urlOrJobId: 'https://example.com',
      });

      expect(result.success).toBe(true);
      if (result.success && result.data) {
        expect(result.data.links[0]).toEqual({
          url: 'https://example.com/page1',
          title: 'Page 1',
          description: 'Description 1',
        });
        expect(result.data.links[0]).not.toHaveProperty('otherField');
      }
    });
  });
});
