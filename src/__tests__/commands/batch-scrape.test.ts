/**
 * Tests for batch-scrape command
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  collectBatchScrapeUrls,
  executeBatchScrape,
} from '../../commands/batch-scrape';
import { getClient } from '../../utils/client';
import { initializeConfig } from '../../utils/config';
import { setupTest, teardownTest } from '../utils/mock-client';

vi.mock('../../utils/client', async () => {
  const actual = await vi.importActual('../../utils/client');
  return {
    ...actual,
    getClient: vi.fn(),
  };
});

const JOB_ID = '550e8400-e29b-41d4-a716-446655440000';
const URLS = ['https://example.com', 'https://example.org'];

describe('collectBatchScrapeUrls', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-scrape-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('combines positional URLs with a URLs file, skipping blanks and comments', () => {
    const file = path.join(tmpDir, 'urls.txt');
    fs.writeFileSync(
      file,
      '# docs\nhttps://example.org/a\n\n  example.org/b  \r\n# end\nhttps://example.com\n'
    );

    expect(collectBatchScrapeUrls(['https://example.com'], file)).toEqual([
      'https://example.com',
      'https://example.org/a',
      'https://example.org/b',
    ]);
  });

  it('normalizes positional URLs without a file', () => {
    expect(collectBatchScrapeUrls(['example.com'])).toEqual([
      'https://example.com',
    ]);
  });

  it('throws a readable error for a missing file', () => {
    expect(() =>
      collectBatchScrapeUrls([], path.join(tmpDir, 'missing.txt'))
    ).toThrow('Could not read --urls-file');
  });
});

describe('executeBatchScrape', () => {
  let mockClient: any;

  beforeEach(() => {
    setupTest();
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });

    mockClient = {
      startBatchScrape: vi.fn(),
      getBatchScrapeStatus: vi.fn(),
      batchScrape: vi.fn(),
      cancelBatchScrape: vi.fn(),
    };
    vi.mocked(getClient).mockReturnValue(mockClient as any);
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
  });

  describe('onlyMainContent', () => {
    it('sends onlyMainContent: false for --full-page', async () => {
      mockClient.startBatchScrape.mockResolvedValue({ id: JOB_ID, url: '' });

      await executeBatchScrape({ urls: URLS, onlyMainContent: false });

      expect(mockClient.startBatchScrape).toHaveBeenCalledWith(URLS, {
        options: { onlyMainContent: false },
        integration: 'cli',
      });
    });
  });

  describe('start (no wait)', () => {
    it('starts a batch job and returns the job ID', async () => {
      mockClient.startBatchScrape.mockResolvedValue({
        id: JOB_ID,
        url: `https://api.firecrawl.dev/v2/batch/scrape/${JOB_ID}`,
      });

      const result = await executeBatchScrape({ urls: URLS });

      expect(mockClient.startBatchScrape).toHaveBeenCalledWith(URLS, {
        options: {},
        integration: 'cli',
      });
      expect(mockClient.batchScrape).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        data: {
          jobId: JOB_ID,
          url: `https://api.firecrawl.dev/v2/batch/scrape/${JOB_ID}`,
          status: 'processing',
        },
      });
    });

    it('passes job options and reports invalid URLs', async () => {
      mockClient.startBatchScrape.mockResolvedValue({
        id: JOB_ID,
        url: 'u',
        invalidURLs: ['not a url'],
      });

      const result = await executeBatchScrape({
        urls: URLS,
        webhook: 'https://hooks.example.com/batch',
        maxConcurrency: 3,
        ignoreInvalidUrls: true,
      });

      expect(mockClient.startBatchScrape).toHaveBeenCalledWith(
        URLS,
        expect.objectContaining({
          webhook: 'https://hooks.example.com/batch',
          maxConcurrency: 3,
          ignoreInvalidURLs: true,
        })
      );
      expect(result.data.invalidURLs).toEqual(['not a url']);
    });

    it('merges --scrape-options under explicit flags', async () => {
      mockClient.startBatchScrape.mockResolvedValue({ id: JOB_ID, url: 'u' });

      await executeBatchScrape({
        urls: URLS,
        format: 'markdown,links',
        onlyMainContent: true,
        waitFor: 1000,
        maxAge: 60000,
        scrapeOptions: {
          formats: ['html'],
          waitFor: 5,
          mobile: true,
        },
      });

      expect(mockClient.startBatchScrape.mock.calls[0][1].options).toEqual({
        formats: ['markdown', 'links'],
        onlyMainContent: true,
        waitFor: 1000,
        maxAge: 60000,
        mobile: true,
      });
    });

    it('requires at least one URL', async () => {
      const result = await executeBatchScrape({ urls: [] });

      expect(result.success).toBe(false);
      expect(result.error).toContain('At least one URL is required');
      expect(mockClient.startBatchScrape).not.toHaveBeenCalled();
    });
  });

  describe('json format', () => {
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
    };

    it('uses only the json format when --schema is passed without --format', async () => {
      mockClient.startBatchScrape.mockResolvedValue({ id: JOB_ID, url: 'u' });

      await executeBatchScrape({ urls: URLS, schema });

      expect(
        mockClient.startBatchScrape.mock.calls[0][1].options.formats
      ).toEqual([{ type: 'json', schema }]);
    });

    it('adds the json format next to requested formats for --prompt', async () => {
      mockClient.startBatchScrape.mockResolvedValue({ id: JOB_ID, url: 'u' });

      await executeBatchScrape({
        urls: URLS,
        format: 'markdown',
        prompt: 'Extract the title',
      });

      expect(
        mockClient.startBatchScrape.mock.calls[0][1].options.formats
      ).toEqual(['markdown', { type: 'json', prompt: 'Extract the title' }]);
    });

    it('fills an explicit json format with schema and prompt', async () => {
      mockClient.startBatchScrape.mockResolvedValue({ id: JOB_ID, url: 'u' });

      await executeBatchScrape({
        urls: URLS,
        format: 'json,links',
        schema,
        prompt: 'Extract the title',
      });

      expect(
        mockClient.startBatchScrape.mock.calls[0][1].options.formats
      ).toEqual([
        { type: 'json', schema, prompt: 'Extract the title' },
        'links',
      ]);
    });

    it('keeps --scrape-options formats when adding the json format', async () => {
      mockClient.startBatchScrape.mockResolvedValue({ id: JOB_ID, url: 'u' });

      await executeBatchScrape({
        urls: URLS,
        schema,
        scrapeOptions: {
          formats: ['markdown', { type: 'json', prompt: 'old' }, 'links'],
        },
      });

      expect(
        mockClient.startBatchScrape.mock.calls[0][1].options.formats
      ).toEqual(['markdown', { type: 'json', schema }, 'links']);
    });

    it('rejects a json format from --scrape-options without a schema or prompt', async () => {
      const result = await executeBatchScrape({
        urls: URLS,
        scrapeOptions: { formats: ['markdown', 'json'] },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'The json format requires --schema, --schema-file, or --prompt'
      );
      expect(mockClient.startBatchScrape).not.toHaveBeenCalled();
    });

    it('rejects the json format without a schema or prompt', async () => {
      const result = await executeBatchScrape({ urls: URLS, format: 'json' });

      expect(result).toEqual({
        success: false,
        error: 'The json format requires --schema, --schema-file, or --prompt',
      });
      expect(mockClient.startBatchScrape).not.toHaveBeenCalled();
    });
  });

  describe('status', () => {
    it('checks status when given a job ID', async () => {
      const job = {
        id: JOB_ID,
        status: 'completed',
        completed: 2,
        total: 2,
        data: [{ markdown: '# A' }, { markdown: '# B' }],
      };
      mockClient.getBatchScrapeStatus.mockResolvedValue(job);

      const result = await executeBatchScrape({ jobId: JOB_ID });

      expect(mockClient.getBatchScrapeStatus).toHaveBeenCalledWith(JOB_ID);
      expect(mockClient.startBatchScrape).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, data: job });
    });

    it('requires a job ID for --status', async () => {
      const result = await executeBatchScrape({ urls: URLS, status: true });

      expect(result).toEqual({
        success: false,
        error: 'Status mode requires a job ID',
      });
      expect(mockClient.getBatchScrapeStatus).not.toHaveBeenCalled();
      expect(mockClient.startBatchScrape).not.toHaveBeenCalled();
    });

    it('returns API errors', async () => {
      mockClient.getBatchScrapeStatus.mockRejectedValue(
        new Error('Job not found')
      );

      const result = await executeBatchScrape({ jobId: JOB_ID });

      expect(result).toEqual({ success: false, error: 'Job not found' });
    });
  });

  describe('wait', () => {
    const job = {
      id: JOB_ID,
      status: 'completed',
      completed: 2,
      total: 2,
      data: [{ markdown: '# A' }, { markdown: '# B' }],
    };

    it('uses the SDK waiter with poll interval and timeout', async () => {
      mockClient.batchScrape.mockResolvedValue(job);

      const result = await executeBatchScrape({
        urls: URLS,
        wait: true,
        timeout: 60,
      });

      expect(mockClient.batchScrape).toHaveBeenCalledWith(URLS, {
        options: {},
        integration: 'cli',
        pollInterval: 2,
        timeout: 60,
      });
      expect(mockClient.startBatchScrape).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, data: job });
    });

    it('polls with progress until the job finishes', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      mockClient.startBatchScrape.mockResolvedValue({ id: JOB_ID, url: 'u' });
      mockClient.getBatchScrapeStatus
        .mockResolvedValueOnce({ ...job, status: 'scraping', completed: 1 })
        .mockResolvedValueOnce({ ...job, data: [] })
        .mockResolvedValueOnce(job);

      const result = await executeBatchScrape({
        urls: URLS,
        wait: true,
        progress: true,
        pollInterval: 0.001,
      });

      expect(mockClient.getBatchScrapeStatus).toHaveBeenNthCalledWith(
        1,
        JOB_ID,
        { autoPaginate: false }
      );
      expect(mockClient.getBatchScrapeStatus).toHaveBeenLastCalledWith(JOB_ID);
      expect(result).toEqual({ success: true, data: job });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('Progress: 1/2 pages (scraping)')
      );
      stderr.mockRestore();
    });

    it('times out the progress loop with a hint naming the job ID', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const now = vi.spyOn(Date, 'now');
      now.mockReturnValueOnce(0).mockReturnValue(2000);
      mockClient.startBatchScrape.mockResolvedValue({ id: JOB_ID, url: 'u' });
      mockClient.getBatchScrapeStatus.mockResolvedValue({
        ...job,
        status: 'scraping',
        completed: 1,
      });

      const result = await executeBatchScrape({
        urls: URLS,
        wait: true,
        progress: true,
        pollInterval: 0.001,
        timeout: 1,
      });

      expect(mockClient.getBatchScrapeStatus).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout after 1 seconds');
      expect(result.error).toContain(`firecrawl batch-scrape ${JOB_ID}`);
      now.mockRestore();
      stderr.mockRestore();
    });
  });

  describe('cancel', () => {
    it('cancels a job by ID', async () => {
      mockClient.cancelBatchScrape.mockResolvedValue(true);

      const result = await executeBatchScrape({
        jobId: JOB_ID,
        cancel: true,
      });

      expect(mockClient.cancelBatchScrape).toHaveBeenCalledWith(JOB_ID);
      expect(mockClient.getBatchScrapeStatus).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        data: { id: JOB_ID, status: 'cancelled' },
      });
    });

    it('reports a failed cancellation', async () => {
      mockClient.cancelBatchScrape.mockResolvedValue(false);

      const result = await executeBatchScrape({
        jobId: JOB_ID,
        cancel: true,
      });

      expect(result).toEqual({
        success: false,
        error: `Failed to cancel batch scrape job ${JOB_ID}`,
      });
    });

    it('requires a job ID', async () => {
      const result = await executeBatchScrape({ urls: URLS, cancel: true });

      expect(result).toEqual({
        success: false,
        error: 'Cancel mode requires a job ID',
      });
      expect(mockClient.cancelBatchScrape).not.toHaveBeenCalled();
    });
  });
});
