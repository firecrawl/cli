/**
 * Tests for authentication utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import {
  interactiveLogin,
  isAuthenticated,
  manualLogin,
} from '../../utils/auth';
import { initializeConfig, resetConfig } from '../../utils/config';
import * as credentials from '../../utils/credentials';

// Mock credentials module
vi.mock('../../utils/credentials', () => ({
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  getConfigDirectoryPath: vi.fn().mockReturnValue('/mock/config/path'),
}));

describe('Authentication Utilities', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
    // Clear env vars
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_API_URL;
    // Mock loadCredentials to return null by default
    vi.mocked(credentials.loadCredentials).mockReturnValue(null);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isAuthenticated', () => {
    it('should return true when API key is set in config', () => {
      initializeConfig({
        apiKey: 'fc-test-api-key',
        apiUrl: 'https://api.firecrawl.dev',
      });

      expect(isAuthenticated()).toBe(true);
    });

    it('should return true when API key is set via environment variable', () => {
      process.env.FIRECRAWL_API_KEY = 'fc-env-api-key';
      initializeConfig({});

      expect(isAuthenticated()).toBe(true);
    });

    it('should return true when API key is in stored credentials', () => {
      vi.mocked(credentials.loadCredentials).mockReturnValue({
        apiKey: 'fc-stored-api-key',
      });
      initializeConfig({});

      expect(isAuthenticated()).toBe(true);
    });

    it('should return false when no API key is set', () => {
      initializeConfig({});

      expect(isAuthenticated()).toBe(false);
    });

    it('should return false when API key is empty string', () => {
      initializeConfig({
        apiKey: '',
      });

      expect(isAuthenticated()).toBe(false);
    });
  });

  describe('Authentication priority', () => {
    it('should prioritize provided API key over env var', () => {
      process.env.FIRECRAWL_API_KEY = 'fc-env-key';
      initializeConfig({
        apiKey: 'fc-provided-key',
      });

      expect(isAuthenticated()).toBe(true);
    });

    it('should prioritize env var over stored credentials', () => {
      process.env.FIRECRAWL_API_KEY = 'fc-env-key';
      vi.mocked(credentials.loadCredentials).mockReturnValue({
        apiKey: 'fc-stored-key',
      });
      initializeConfig({});

      expect(isAuthenticated()).toBe(true);
    });

    it('should fall back to stored credentials when no other source', () => {
      vi.mocked(credentials.loadCredentials).mockReturnValue({
        apiKey: 'fc-stored-key',
      });
      initializeConfig({});

      expect(isAuthenticated()).toBe(true);
    });
  });

  describe('login prompts without a terminal', () => {
    const realStdin = process.stdin;
    let stdin: PassThrough;

    beforeEach(() => {
      stdin = new PassThrough();
      Object.defineProperty(process, 'stdin', {
        value: stdin,
        configurable: true,
      });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      Object.defineProperty(process, 'stdin', {
        value: realStdin,
        configurable: true,
      });
      vi.restoreAllMocks();
    });

    it('rejects the login menu when stdin ends without a choice', async () => {
      const login = interactiveLogin();
      stdin.end();

      await expect(login).rejects.toThrow(/No input to log in with/);
    });

    it('rejects manual login when stdin ends without a key', async () => {
      const login = manualLogin();
      stdin.end();

      await expect(login).rejects.toThrow(/No input to log in with/);
    });

    it('reads a piped API key without a trailing newline', async () => {
      const login = manualLogin();
      stdin.end('fc-unterminated-key');

      await expect(login).resolves.toEqual({
        apiKey: 'fc-unterminated-key',
        apiUrl: 'https://api.firecrawl.dev',
      });
    });

    it('ignores a terminal buffer when the terminal ends the prompt', async () => {
      Object.assign(stdin, { isTTY: true });
      const login = manualLogin();
      stdin.write('fc-erased');
      stdin.end();

      await expect(login).rejects.toThrow(/No input to log in with/);
    });

    it('still reads a piped API key', async () => {
      const login = manualLogin();
      stdin.end('fc-piped-key\n');

      await expect(login).resolves.toEqual({
        apiKey: 'fc-piped-key',
        apiUrl: 'https://api.firecrawl.dev',
      });
    });
  });
});
