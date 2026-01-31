/**
 * Tests for config fallback priority
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initializeConfig,
  getConfig,
  resetConfig,
  updateConfig,
  validateConfig,
  isCustomApiUrl,
} from '../../utils/config';
import { getClient, resetClient } from '../../utils/client';
import * as credentials from '../../utils/credentials';

// Mock credentials module
vi.mock('../../utils/credentials', () => ({
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
}));

describe('Config Fallback Priority', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset everything before each test
    resetClient();
    resetConfig();
    vi.clearAllMocks();

    // Clear env vars
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_API_URL;

    // Mock loadCredentials to return null by default
    vi.mocked(credentials.loadCredentials).mockReturnValue(null);
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  describe('initializeConfig fallback priority', () => {
    it('should prioritize provided config over env vars', () => {
      process.env.FIRECRAWL_API_KEY = 'env-api-key';
      process.env.FIRECRAWL_API_URL = 'https://env-api-url.com';

      initializeConfig({
        apiKey: 'provided-api-key',
        apiUrl: 'https://provided-api-url.com',
      });

      const config = getConfig();
      expect(config.apiKey).toBe('provided-api-key');
      expect(config.apiUrl).toBe('https://provided-api-url.com');
    });

    it('should use env vars when provided config is not set', () => {
      process.env.FIRECRAWL_API_KEY = 'env-api-key';
      process.env.FIRECRAWL_API_URL = 'https://env-api-url.com';

      initializeConfig({});

      const config = getConfig();
      expect(config.apiKey).toBe('env-api-key');
      expect(config.apiUrl).toBe('https://env-api-url.com');
    });

    it('should fallback to stored credentials when env vars are not set', () => {
      vi.mocked(credentials.loadCredentials).mockReturnValue({
        apiKey: 'stored-api-key',
        apiUrl: 'https://stored-api-url.com',
      });

      initializeConfig({});

      const config = getConfig();
      expect(config.apiKey).toBe('stored-api-key');
      expect(config.apiUrl).toBe('https://stored-api-url.com');
    });

    it('should prioritize provided config > env vars > stored credentials', () => {
      process.env.FIRECRAWL_API_KEY = 'env-api-key';
      vi.mocked(credentials.loadCredentials).mockReturnValue({
        apiKey: 'stored-api-key',
      });

      // Provided config should win
      initializeConfig({ apiKey: 'provided-api-key' });
      expect(getConfig().apiKey).toBe('provided-api-key');

      // Reset and test env var priority
      resetConfig();
      initializeConfig({});
      expect(getConfig().apiKey).toBe('env-api-key');

      // Reset and test stored credentials fallback
      resetConfig();
      delete process.env.FIRECRAWL_API_KEY;
      initializeConfig({});
      expect(getConfig().apiKey).toBe('stored-api-key');
    });
  });

  describe('getClient fallback priority', () => {
    beforeEach(() => {
      // Set up base config
      initializeConfig({
        apiKey: 'global-api-key',
        apiUrl: 'https://global-url.com',
      });
    });

    it('should prioritize options over global config', () => {
      const client = getClient({ apiKey: 'option-api-key' });

      // Verify client was created with option API key
      // We can't directly inspect the client, but we can check the config was updated
      const config = getConfig();
      expect(config.apiKey).toBe('option-api-key');
    });

    it('should use global config when options not provided', () => {
      getClient();

      const config = getConfig();
      expect(config.apiKey).toBe('global-api-key');
      expect(config.apiUrl).toBe('https://global-url.com');
    });

    it('should merge options with global config', () => {
      initializeConfig({
        apiKey: 'global-api-key',
        apiUrl: 'https://global-url.com',
        timeoutMs: 30000,
      });

      getClient({ apiKey: 'option-api-key' });

      const config = getConfig();
      expect(config.apiKey).toBe('option-api-key'); // Option overrides
      expect(config.apiUrl).toBe('https://global-url.com'); // Global preserved
      expect(config.timeoutMs).toBe(30000); // Global preserved
    });

    it('should handle undefined options gracefully', () => {
      initializeConfig({ apiKey: 'global-api-key' });

      getClient({ apiKey: undefined });

      // When undefined is passed, it should not override
      const config = getConfig();
      expect(config.apiKey).toBe('global-api-key');
    });
  });

  describe('Combined fallback chain', () => {
    it('should follow: options > global config > env vars > stored credentials', () => {
      // Set up stored credentials
      vi.mocked(credentials.loadCredentials).mockReturnValue({
        apiKey: 'stored-api-key',
      });

      // Set up env vars
      process.env.FIRECRAWL_API_KEY = 'env-api-key';

      // Initialize with env vars (should use env > stored)
      initializeConfig({});
      expect(getConfig().apiKey).toBe('env-api-key');

      // Options should override everything
      getClient({ apiKey: 'option-api-key' });
      expect(getConfig().apiKey).toBe('option-api-key');

      // After reset, should fall back to env
      resetConfig();
      initializeConfig({});
      expect(getConfig().apiKey).toBe('env-api-key');

      // After clearing env, should fall back to stored
      resetConfig();
      delete process.env.FIRECRAWL_API_KEY;
      initializeConfig({});
      expect(getConfig().apiKey).toBe('stored-api-key');
    });

    it('should update global config when getClient is called with options', () => {
      process.env.FIRECRAWL_API_KEY = 'env-api-key';
      initializeConfig({});

      // Initially should use env var
      expect(getConfig().apiKey).toBe('env-api-key');

      // Call getClient with option
      getClient({ apiKey: 'option-api-key' });

      // Global config should now be updated
      expect(getConfig().apiKey).toBe('option-api-key');

      // Subsequent getClient calls without options should use updated global config
      resetClient(); // Reset client instance
      getClient();
      expect(getConfig().apiKey).toBe('option-api-key');
    });
  });

  describe('updateConfig behavior', () => {
    it('should merge with existing config', () => {
      initializeConfig({
        apiKey: 'initial-key',
        apiUrl: 'https://initial-url.com',
      });

      updateConfig({ apiKey: 'updated-key' });

      const config = getConfig();
      expect(config.apiKey).toBe('updated-key');
      expect(config.apiUrl).toBe('https://initial-url.com'); // Should be preserved
    });

    it('should allow partial updates', () => {
      initializeConfig({
        apiKey: 'key1',
        apiUrl: 'https://url1.com',
      });

      updateConfig({ apiUrl: 'https://url2.com' });

      const config = getConfig();
      expect(config.apiKey).toBe('key1'); // Should be preserved
      expect(config.apiUrl).toBe('https://url2.com'); // Should be updated
    });
  });

  describe('isCustomApiUrl', () => {
    it('should return false for default cloud API URL', () => {
      initializeConfig({ apiUrl: 'https://api.firecrawl.dev' });
      expect(isCustomApiUrl()).toBe(false);
    });

    it('should return true for custom API URLs', () => {
      initializeConfig({ apiUrl: 'http://localhost:3002' });
      expect(isCustomApiUrl()).toBe(true);
    });

    it('should return false when no apiUrl is set', () => {
      initializeConfig({});
      expect(isCustomApiUrl()).toBe(false);
    });

    it('should accept apiUrl parameter override', () => {
      initializeConfig({ apiUrl: 'https://api.firecrawl.dev' });
      expect(isCustomApiUrl('http://localhost:3002')).toBe(true);
    });
  });

  describe('validateConfig with custom API URLs', () => {
    it('should not require API key for custom API URLs', () => {
      initializeConfig({ apiUrl: 'http://localhost:3002' });
      // Should not throw
      expect(() => validateConfig()).not.toThrow();
    });

    it('should require API key for cloud API URL', () => {
      initializeConfig({ apiUrl: 'https://api.firecrawl.dev' });
      expect(() => validateConfig()).toThrow('API key is required');
    });

    it('should not throw when API key is provided for cloud API', () => {
      initializeConfig({
        apiUrl: 'https://api.firecrawl.dev',
        apiKey: 'fc-test-key',
      });
      expect(() => validateConfig()).not.toThrow();
    });
  });
});
