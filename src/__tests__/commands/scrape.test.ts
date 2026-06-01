/**
 * Tests for scrape command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeScrape } from '../../commands/scrape';
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

describe('executeScrape', () => {
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
      scrape: vi.fn(),
    };

    // Mock getClient to return our mock
    vi.mocked(getClient).mockReturnValue(mockClient as any);
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
  });

  describe('API call generation', () => {
    it('should call scrape with correct URL and default markdown format', async () => {
      const mockResponse = { markdown: '# Test Content' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
      });

      expect(mockClient.scrape).toHaveBeenCalledTimes(1);
      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown'],
        integration: 'cli',
      });
    });

    it('should pass apiUrl to getClient when provided', async () => {
      const mockResponse = { markdown: '# Test Content' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        apiUrl: 'http://localhost:3002',
      });

      expect(getClient).toHaveBeenCalledWith({
        apiKey: undefined,
        apiUrl: 'http://localhost:3002',
      });
    });

    it('should pass both apiKey and apiUrl to getClient when provided', async () => {
      const mockResponse = { markdown: '# Test Content' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        apiKey: 'fc-custom-key',
        apiUrl: 'http://localhost:3002',
      });

      expect(getClient).toHaveBeenCalledWith({
        apiKey: 'fc-custom-key',
        apiUrl: 'http://localhost:3002',
      });
    });

    it('should call scrape with specified format', async () => {
      const mockResponse = { html: '<html>...</html>' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        formats: ['html'],
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['html'],
        integration: 'cli',
      });
    });

    it('should call scrape with summary format when summary option is true', async () => {
      const mockResponse = { summary: 'This is a summary of the page.' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        formats: ['summary'],
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['summary'],
        integration: 'cli',
      });
    });

    it('should include screenshot format when screenshot option is true', async () => {
      const mockResponse = {
        markdown: '# Test',
        screenshot: 'base64image...',
      };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        screenshot: true,
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['screenshot'],
        integration: 'cli',
      });
    });

    it('should include screenshot format alongside other formats', async () => {
      const mockResponse = {
        markdown: '# Test',
        screenshot: 'base64image...',
      };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        formats: ['markdown'],
        screenshot: true,
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown', 'screenshot'],
        integration: 'cli',
      });
    });

    it('should include onlyMainContent parameter when provided', async () => {
      const mockResponse = { markdown: '# Test' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        onlyMainContent: true,
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown'],
        integration: 'cli',
        onlyMainContent: true,
      });
    });

    it('should include waitFor parameter when provided', async () => {
      const mockResponse = { markdown: '# Test' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        waitFor: 2000,
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown'],
        integration: 'cli',
        waitFor: 2000,
      });
    });

    it('should include includeTags parameter when provided', async () => {
      const mockResponse = { markdown: '# Test' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        includeTags: ['article', 'main'],
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown'],
        integration: 'cli',
        includeTags: ['article', 'main'],
      });
    });

    it('should include excludeTags parameter when provided', async () => {
      const mockResponse = { markdown: '# Test' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        excludeTags: ['nav', 'footer'],
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown'],
        integration: 'cli',
        excludeTags: ['nav', 'footer'],
      });
    });

    it('should combine all parameters correctly', async () => {
      const mockResponse = { markdown: '# Test', screenshot: 'base64...' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        formats: ['markdown'],
        screenshot: true,
        onlyMainContent: true,
        waitFor: 3000,
        includeTags: ['article'],
        excludeTags: ['nav'],
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown', 'screenshot'],
        integration: 'cli',
        onlyMainContent: true,
        waitFor: 3000,
        includeTags: ['article'],
        excludeTags: ['nav'],
      });
    });

    it('should include maxAge parameter when provided', async () => {
      const mockResponse = { markdown: '# Test' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        maxAge: 3600,
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown'],
        integration: 'cli',
        maxAge: 3600,
      });
    });

    it('should include location parameter with country and languages', async () => {
      const mockResponse = { markdown: '# Test' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        location: { country: 'US', languages: ['en'] },
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown'],
        integration: 'cli',
        location: { country: 'US', languages: ['en'] },
      });
    });

    it('should include location parameter with only country', async () => {
      const mockResponse = { markdown: '# Test' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        location: { country: 'DE' },
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown'],
        integration: 'cli',
        location: { country: 'DE' },
      });
    });

    it('should include location parameter with only languages', async () => {
      const mockResponse = { markdown: '# Test' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        location: { languages: ['en', 'es'] },
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown'],
        integration: 'cli',
        location: { languages: ['en', 'es'] },
      });
    });

    it('should include schema in json format when provided', async () => {
      const mockResponse = { json: { title: 'Example Domain' } };
      const schema = {
        type: 'object',
        properties: {
          title: { type: 'string' },
        },
        required: ['title'],
      };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        formats: ['json'],
        schema,
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: [{ type: 'json', schema }],
        integration: 'cli',
      });
    });

    it('should include actions and proxy when provided', async () => {
      const mockResponse = { markdown: '# Test' };
      const actions = [{ type: 'wait', milliseconds: 100 }];
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        actions,
        proxy: 'basic',
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown'],
        integration: 'cli',
        actions,
        proxy: 'basic',
      });
    });

    it('should include redactPII when provided', async () => {
      const mockResponse = { markdown: '# Test' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
        redactPII: true,
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown'],
        integration: 'cli',
        redactPII: true,
      });
    });

    it('should not include location parameter when not provided', async () => {
      const mockResponse = { markdown: '# Test' };
      mockClient.scrape.mockResolvedValue(mockResponse);

      await executeScrape({
        url: 'https://example.com',
      });

      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown'],
        integration: 'cli',
      });
    });
  });

  describe('Response handling', () => {
    it('should return success result with data when scrape succeeds', async () => {
      const mockResponse = {
        markdown: '# Test Content',
        url: 'https://example.com',
      };
      mockClient.scrape.mockResolvedValue(mockResponse);

      const result = await executeScrape({
        url: 'https://example.com',
      });

      expect(result).toEqual({
        success: true,
        data: mockResponse,
      });
    });

    it('should handle complex response data', async () => {
      const mockResponse = {
        markdown: '# Test',
        html: '<html>...</html>',
        screenshot: 'base64image...',
        metadata: {
          title: 'Test Page',
          description: 'Test description',
        },
      };
      mockClient.scrape.mockResolvedValue(mockResponse);

      const result = await executeScrape({
        url: 'https://example.com',
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse);
    });

    it('should return error result when scrape fails', async () => {
      const errorMessage = 'API Error: Invalid URL';
      mockClient.scrape.mockRejectedValue(new Error(errorMessage));

      const result = await executeScrape({
        url: 'https://example.com',
      });

      expect(result).toEqual({
        success: false,
        error: errorMessage,
      });
    });

    it('should handle non-Error exceptions', async () => {
      mockClient.scrape.mockRejectedValue('String error');

      const result = await executeScrape({
        url: 'https://example.com',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error occurred');
    });
  });

  describe('Type safety', () => {
    it('should accept valid ScrapeFormat types', async () => {
      const formatList: Array<'markdown' | 'html' | 'rawHtml' | 'links'> = [
        'markdown',
        'html',
        'rawHtml',
        'links',
      ];

      for (const format of formatList) {
        mockClient.scrape.mockResolvedValue({ [format]: 'test' });
        const result = await executeScrape({
          url: 'https://example.com',
          formats: [format],
        });
        expect(result.success).toBe(true);
      }
    });

    it('should accept multiple formats', async () => {
      mockClient.scrape.mockResolvedValue({
        markdown: '# Test',
        links: ['http://a.com'],
        images: ['http://img.com/a.png'],
      });

      const result = await executeScrape({
        url: 'https://example.com',
        formats: ['markdown', 'links', 'images'],
      });

      expect(result.success).toBe(true);
      expect(mockClient.scrape).toHaveBeenCalledWith('https://example.com', {
        formats: ['markdown', 'links', 'images'],
        integration: 'cli',
      });
    });
  });
});
