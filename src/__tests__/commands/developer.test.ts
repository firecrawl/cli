/**
 * Tests for developer command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleDeveloperSearchCommand } from '../../commands/developer';
import { getClient } from '../../utils/client';
import { initializeConfig } from '../../utils/config';
import { writeOutput } from '../../utils/output';
import { setupTest, teardownTest } from '../utils/mock-client';

vi.mock('../../utils/output', () => ({ writeOutput: vi.fn() }));

vi.mock('../../utils/client', async () => {
  const actual = await vi.importActual('../../utils/client');
  return {
    ...actual,
    getClient: vi.fn(),
  };
});

describe('handleDeveloperSearchCommand', () => {
  let mockHttpGet: ReturnType<typeof vi.fn>;

  // Wrap a payload in the axios envelope returned by `client.http.get`.
  const mockDeveloperResponse = (results: any[], extra = {}) => ({
    data: { success: true, results, ...extra },
  });

  const sampleResult = {
    id: 'issue:tokio-rs/tokio#2309',
    url: 'https://github.com/tokio-rs/tokio/issues/2309',
    title: 'spawn_blocking panics when exceeding the thread limit',
    passages: [
      {
        text: 'It will panic if this limit is too low.',
        citation_url:
          'https://github.com/tokio-rs/tokio/issues/2309#issuecomment-1',
      },
    ],
    license: { state: 'licensed', spdx_id: 'MIT' },
  };

  beforeEach(() => {
    setupTest();
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });

    mockHttpGet = vi.fn();
    vi.mocked(getClient).mockReturnValue({
      http: { get: mockHttpGet },
    } as any);
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
  });

  describe('API call generation', () => {
    it('calls /v2/search/developer without a client passage budget', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([sampleResult]));

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      expect(mockHttpGet).toHaveBeenCalledTimes(1);
      expect(mockHttpGet).toHaveBeenCalledWith(
        '/v2/search/developer?query=tokio+spawn_blocking&integration=cli'
      );
    });

    it('passes k when a result count is provided', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([sampleResult]));

      await handleDeveloperSearchCommand({
        query: 'tokio spawn_blocking',
        k: 5,
      });

      expect(mockHttpGet).toHaveBeenCalledWith(
        '/v2/search/developer?query=tokio+spawn_blocking&k=5&integration=cli'
      );
    });

    it('passes apiUrl and apiKey to getClient when provided', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([]));

      await handleDeveloperSearchCommand({
        query: 'test',
        apiKey: 'other-key',
        apiUrl: 'http://localhost:3002',
      });

      expect(getClient).toHaveBeenCalledWith({
        apiKey: 'other-key',
        apiUrl: 'http://localhost:3002',
      });
    });
  });

  describe('output', () => {
    it('renders id, type, title, url, and passage in readable output', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([sampleResult]));

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0];
      expect(content).toContain(
        '## [issue:tokio-rs/tokio#2309] (issue) spawn_blocking panics when exceeding the thread limit'
      );
      expect(content).toContain(
        'https://github.com/tokio-rs/tokio/issues/2309'
      );
      expect(content).toContain('It will panic if this limit is too low.');
    });

    it('renders full passages, citations, licenses, and indexing echoes', async () => {
      const passage = 'x'.repeat(5000);
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse(
          [{ ...sampleResult, passages: [{ text: passage }], license: 'MIT' }],
          {
            repos: [
              {
                repo: 'tokio-rs/tokio',
                indexed: true,
                types: { issue: true, pullRequest: true, readme: false },
              },
            ],
            sources: [{ source: 'rust', indexed: false }],
          }
        )
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      expect(content).toContain(passage);
      expect(content).toContain('License: MIT');
      expect(content).toContain('tokio-rs/tokio: indexed');
      expect(content).toContain('rust: not indexed');
    });

    it('renders citation URLs and object license disclosures', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([sampleResult]));

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      expect(content).toContain('License: MIT');
      expect(content).toContain(
        'Citation: https://github.com/tokio-rs/tokio/issues/2309#issuecomment-1'
      );
    });

    it('prints a placeholder when there are no results', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([]));

      await handleDeveloperSearchCommand({ query: 'no hits' });

      const [content] = vi.mocked(writeOutput).mock.calls[0];
      expect(content).toBe('(no results)');
    });

    it('tolerates a success response that omits results', async () => {
      mockHttpGet.mockResolvedValue({ data: { success: true } });

      await handleDeveloperSearchCommand({ query: 'no result field' });

      const [content] = vi.mocked(writeOutput).mock.calls[0];
      expect(content).toBe('(no results)');
    });

    it('outputs the full envelope as JSON with --json', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([sampleResult]));

      await handleDeveloperSearchCommand({
        query: 'tokio spawn_blocking',
        json: true,
      });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const parsed = JSON.parse(content);
      expect(parsed.results[0].passages[0].text).toBe(
        'It will panic if this limit is too low.'
      );
    });
  });

  describe('error handling', () => {
    it('exits with code 1 when the request fails', async () => {
      mockHttpGet.mockRejectedValue(new Error('boom'));
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as any);
      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await handleDeveloperSearchCommand({ query: 'test' });

      expect(errorSpy).toHaveBeenCalledWith('Error:', 'boom');
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});
