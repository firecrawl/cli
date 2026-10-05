/**
 * Tests for legal-regulatory command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleLegalRegulatorySearchCommand } from '../../commands/legal-regulatory';
import { getClient, isKeylessMode } from '../../utils/client';
import { initializeConfig } from '../../utils/config';
import { writeOutput } from '../../utils/output';
import { setupTest, teardownTest } from '../utils/mock-client';

vi.mock('../../utils/output', () => ({ writeOutput: vi.fn() }));

vi.mock('../../utils/client', async () => {
  const actual = await vi.importActual('../../utils/client');
  return {
    ...actual,
    getClient: vi.fn(),
    isKeylessMode: vi.fn(() => false),
  };
});

describe('handleLegalRegulatorySearchCommand', () => {
  let mockHttpGet: ReturnType<typeof vi.fn>;

  // Wrap a payload in the axios envelope returned by `client.http.get`.
  const mockLegalRegulatoryResponse = (web: any[]) => ({
    data: { success: true, data: { web } },
  });

  const sampleResult = {
    url: 'https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-101',
    title: '21 CFR Part 101 -- Food Labeling',
    description: 'Food labeling requirements for packaged foods.',
    position: 1,
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
    vi.unstubAllGlobals();
  });

  describe('API call generation', () => {
    it('calls /v2/search/gov with the query', async () => {
      mockHttpGet.mockResolvedValue(
        mockLegalRegulatoryResponse([sampleResult])
      );

      await handleLegalRegulatorySearchCommand({ query: 'food labeling' });

      expect(mockHttpGet).toHaveBeenCalledTimes(1);
      expect(mockHttpGet).toHaveBeenCalledWith(
        '/v2/search/gov?query=food+labeling&integration=cli'
      );
    });

    it('passes k when a result count is provided', async () => {
      mockHttpGet.mockResolvedValue(
        mockLegalRegulatoryResponse([sampleResult])
      );

      await handleLegalRegulatorySearchCommand({
        query: 'food labeling',
        k: 5,
      });

      expect(mockHttpGet).toHaveBeenCalledWith(
        '/v2/search/gov?query=food+labeling&k=5&integration=cli'
      );
    });

    it('passes apiUrl and apiKey to getClient when provided', async () => {
      mockHttpGet.mockResolvedValue(mockLegalRegulatoryResponse([]));

      await handleLegalRegulatorySearchCommand({
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
    it('renders numbered title, url, and description blocks', async () => {
      mockHttpGet.mockResolvedValue(
        mockLegalRegulatoryResponse([
          sampleResult,
          {
            url: 'https://www.ecfr.gov/current/title-21/part-102',
            title: '21 CFR Part 102',
            position: 2,
          },
        ])
      );

      await handleLegalRegulatorySearchCommand({ query: 'food labeling' });

      const [content] = vi.mocked(writeOutput).mock.calls[0];
      expect(content).toBe(
        [
          '## 1. 21 CFR Part 101 -- Food Labeling',
          sampleResult.url,
          'Food labeling requirements for packaged foods.',
          '',
          '## 2. 21 CFR Part 102',
          'https://www.ecfr.gov/current/title-21/part-102',
        ].join('\n')
      );
    });

    it('prints a placeholder when there are no results', async () => {
      mockHttpGet.mockResolvedValue(mockLegalRegulatoryResponse([]));

      await handleLegalRegulatorySearchCommand({ query: 'no hits' });

      const [content] = vi.mocked(writeOutput).mock.calls[0];
      expect(content).toBe('(no results)');
    });

    it('tolerates a success response that omits data', async () => {
      mockHttpGet.mockResolvedValue({ data: { success: true } });

      await handleLegalRegulatorySearchCommand({ query: 'no data field' });

      const [content] = vi.mocked(writeOutput).mock.calls[0];
      expect(content).toBe('(no results)');
    });

    it('outputs the raw response as JSON with --json', async () => {
      mockHttpGet.mockResolvedValue(
        mockLegalRegulatoryResponse([sampleResult])
      );

      await handleLegalRegulatorySearchCommand({
        query: 'food labeling',
        json: true,
      });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      expect(JSON.parse(content)).toEqual({
        success: true,
        data: { web: [sampleResult] },
      });
    });

    it('writes to the output file with -o', async () => {
      mockHttpGet.mockResolvedValue(
        mockLegalRegulatoryResponse([sampleResult])
      );

      await handleLegalRegulatorySearchCommand({
        query: 'food labeling',
        output: 'results.md',
      });

      expect(writeOutput).toHaveBeenCalledWith(
        expect.any(String),
        'results.md',
        true
      );
    });
  });

  describe('keyless mode', () => {
    it('calls the endpoint directly and renders the results', async () => {
      vi.mocked(isKeylessMode).mockReturnValueOnce(true);
      const fetchMock = vi.fn(
        async (_url: string, _init?: RequestInit) =>
          new Response(
            JSON.stringify({ success: true, data: { web: [sampleResult] } }),
            { status: 200 }
          )
      );
      vi.stubGlobal('fetch', fetchMock);

      await handleLegalRegulatorySearchCommand({ query: 'food labeling' });

      expect(mockHttpGet).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.firecrawl.dev/v2/search/gov?query=food+labeling&integration=cli',
        expect.objectContaining({ method: 'GET' })
      );
      expect(vi.mocked(writeOutput).mock.calls[0][0]).toContain(
        sampleResult.title
      );
    });
  });

  describe('error handling', () => {
    it('exits with code 1 when the response reports a failure', async () => {
      mockHttpGet.mockResolvedValue({
        data: { success: false, error: 'Search failed' },
      });
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as any);
      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await handleLegalRegulatorySearchCommand({ query: 'test' });

      expect(errorSpy).toHaveBeenCalledWith('Error:', 'Search failed');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(writeOutput).not.toHaveBeenCalled();

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('exits with code 1 when the request fails', async () => {
      mockHttpGet.mockRejectedValue(new Error('boom'));
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as any);
      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await handleLegalRegulatorySearchCommand({ query: 'test' });

      expect(errorSpy).toHaveBeenCalledWith('Error:', 'boom');
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});
