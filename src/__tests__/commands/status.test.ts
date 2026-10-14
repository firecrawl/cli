/**
 * Tests for status command self-hosted recognition.
 *
 * Regression coverage for #53: a stored apiUrl pointing at a self-hosted
 * Firecrawl instance with no apiKey must be reported as a configured
 * "self-hosted" auth source, not "Not authenticated". The fetch helpers
 * must also avoid sending `Authorization: Bearer undefined` in that case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getStatus } from '../../commands/status';
import { initializeConfig, resetConfig } from '../../utils/config';
import * as credentials from '../../utils/credentials';

vi.mock('../../utils/credentials', () => ({
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  getConfigDirectoryPath: vi.fn().mockReturnValue('/mock/config/path'),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

describe('getStatus self-hosted handling', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_API_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reports authSource=self-hosted when apiUrl is custom and apiKey is missing', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      apiUrl: 'http://localhost:3002',
    });
    initializeConfig({ apiUrl: 'http://localhost:3002' });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    const status = await getStatus();

    expect(status.authSource).toBe('self-hosted');
    expect(status.authenticated).toBe(true);
  });

  it('does not send Authorization header when self-hosted has no apiKey', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      apiUrl: 'http://localhost:3002',
    });
    initializeConfig({ apiUrl: 'http://localhost:3002' });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    await getStatus();

    expect(mockFetch).toHaveBeenCalled();
    for (const call of mockFetch.mock.calls) {
      const headers = (call[1]?.headers ?? {}) as Record<string, string>;
      expect(headers).not.toHaveProperty('Authorization');
      expect(JSON.stringify(headers)).not.toContain('Bearer undefined');
    }
  });

  it('still reports stored when apiKey is present alongside apiUrl', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      apiKey: 'fc-test-key',
      apiUrl: 'http://localhost:3002',
    });
    initializeConfig({
      apiKey: 'fc-test-key',
      apiUrl: 'http://localhost:3002',
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    const status = await getStatus();

    expect(status.authSource).toBe('stored');
    expect(status.authenticated).toBe(true);
  });

  it('reports none when no apiKey and apiUrl is the default cloud URL', async () => {
    vi.mocked(credentials.loadCredentials).mockReturnValue({
      apiUrl: 'https://api.firecrawl.dev',
    });
    initializeConfig({ apiUrl: 'https://api.firecrawl.dev' });

    const status = await getStatus();

    expect(status.authSource).toBe('none');
    expect(status.authenticated).toBe(false);
  });
});
