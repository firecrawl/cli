/**
 * Tests for credit-usage command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeCreditUsage } from '../../commands/credit-usage';
import { initializeConfig } from '../../utils/config';
import { setupTest, teardownTest } from '../utils/mock-client';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

describe('executeCreditUsage', () => {
  beforeEach(() => {
    setupTest();
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
  });

  describe('API call generation', () => {
    it('should make GET request to correct endpoint', async () => {
      const mockResponse = {
        remainingCredits: 1000,
        planCredits: 5000,
        billingPeriodStart: '2024-01-01',
        billingPeriodEnd: '2024-01-31',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockResponse }),
      });

      await executeCreditUsage();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.firecrawl.dev/v2/team/credit-usage',
        {
          method: 'GET',
          headers: {
            Authorization: 'Bearer test-api-key',
            'Content-Type': 'application/json',
          },
        }
      );
    });

    it('should use custom API URL when provided', async () => {
      initializeConfig({
        apiKey: 'test-api-key',
        apiUrl: 'https://custom-api.example.com',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { remainingCredits: 1000 } }),
      });

      await executeCreditUsage();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom-api.example.com/v2/team/credit-usage',
        expect.any(Object)
      );
    });

    it('should handle API URL with trailing slash', async () => {
      initializeConfig({
        apiKey: 'test-api-key',
        apiUrl: 'https://api.firecrawl.dev/',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { remainingCredits: 1000 } }),
      });

      await executeCreditUsage();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.firecrawl.dev/v2/team/credit-usage',
        expect.any(Object)
      );
    });

    it('should include API key from options when provided', async () => {
      initializeConfig({
        apiKey: 'config-api-key',
        apiUrl: 'https://api.firecrawl.dev',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { remainingCredits: 1000 } }),
      });

      await executeCreditUsage({ apiKey: 'option-api-key' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer option-api-key',
          }),
        })
      );
    });
  });

  describe('Response handling', () => {
    it('should return success result with credit data', async () => {
      const mockData = {
        remainingCredits: 1000,
        planCredits: 5000,
        billingPeriodStart: '2024-01-01T00:00:00Z',
        billingPeriodEnd: '2024-01-31T23:59:59Z',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockData }),
      });

      const result = await executeCreditUsage();

      expect(result).toEqual({
        success: true,
        data: mockData,
      });
    });

    it('should handle response with direct data (not nested)', async () => {
      const mockData = {
        remainingCredits: 500,
        planCredits: 2000,
        billingPeriodStart: null,
        billingPeriodEnd: null,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockData,
      });

      const result = await executeCreditUsage();

      expect(result).toEqual({
        success: true,
        data: mockData,
      });
    });

    it('should handle HTTP error responses', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ error: 'Invalid API key' }),
      });

      const result = await executeCreditUsage();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid API key');
    });

    it('should handle HTTP error without error message', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({}),
      });

      const result = await executeCreditUsage();

      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 500: Internal Server Error');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await executeCreditUsage();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should handle invalid JSON responses', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      const result = await executeCreditUsage();

      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 500: Internal Server Error');
    });
  });

  describe('Data extraction', () => {
    it('should extract all required fields from response', async () => {
      const mockData = {
        remainingCredits: 1000,
        planCredits: 5000,
        billingPeriodStart: '2024-01-01',
        billingPeriodEnd: '2024-01-31',
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockData }),
      });

      const result = await executeCreditUsage();

      expect(result.data).toHaveProperty('remainingCredits', 1000);
      expect(result.data).toHaveProperty('planCredits', 5000);
      expect(result.data).toHaveProperty('billingPeriodStart', '2024-01-01');
      expect(result.data).toHaveProperty('billingPeriodEnd', '2024-01-31');
    });

    it('should handle null billing period dates', async () => {
      const mockData = {
        remainingCredits: 1000,
        planCredits: 5000,
        billingPeriodStart: null,
        billingPeriodEnd: null,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ data: mockData }),
      });

      const result = await executeCreditUsage();

      expect(result.data?.billingPeriodStart).toBeNull();
      expect(result.data?.billingPeriodEnd).toBeNull();
    });
  });
});
