/**
 * Batch scrape command implementation
 */

import { readFileSync } from 'fs';
import type {
  BatchScrapeCommandOptions,
  BatchScrapeResult,
} from '../types/batch-scrape';
import { getClient } from '../utils/client';
import { parseFormats } from '../utils/options';
import { writeOutput } from '../utils/output';
import { normalizeUrl } from '../utils/url';

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * Collect URLs from positional arguments and an optional file with one URL
 * per line. Blank lines and lines starting with # are ignored.
 */
export function collectBatchScrapeUrls(
  positional: string[],
  urlsFile?: string
): string[] {
  let fromFile: string[] = [];
  if (urlsFile) {
    let content: string;
    try {
      content = readFileSync(urlsFile, 'utf-8');
    } catch {
      throw new Error(`Could not read --urls-file: ${urlsFile}`);
    }
    fromFile = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  }

  return [...new Set([...positional, ...fromFile].map(normalizeUrl))];
}

/**
 * Build the scrape options applied to every URL. Explicit flags override
 * --scrape-options; --schema and --prompt add the json format.
 */
export function buildBatchScrapeOptions(
  options: BatchScrapeCommandOptions
): Record<string, unknown> {
  const { schema, prompt } = options;
  const wantsJson = schema !== undefined || prompt !== undefined;
  const scrapeOptions: Record<string, unknown> = {
    onlyMainContent: false,
    ...options.scrapeOptions,
  };

  const formats = options.format
    ? parseFormats(options.format)
    : wantsJson
      ? []
      : undefined;
  if (formats) {
    if (wantsJson && !formats.includes('json')) {
      formats.push('json');
    }
    if (formats.includes('json') && !wantsJson) {
      throw new Error(
        'The json format requires --schema, --schema-file, or --prompt'
      );
    }
    scrapeOptions.formats = formats.map((format) =>
      format === 'json'
        ? {
            type: 'json',
            ...(schema !== undefined ? { schema } : {}),
            ...(prompt !== undefined ? { prompt } : {}),
          }
        : format
    );
  }

  if (options.onlyMainContent) {
    scrapeOptions.onlyMainContent = true;
  }
  if (options.waitFor !== undefined) {
    scrapeOptions.waitFor = options.waitFor;
  }
  if (options.maxAge !== undefined) {
    scrapeOptions.maxAge = options.maxAge;
  }

  return scrapeOptions;
}

/**
 * Execute batch scrape command
 */
export async function executeBatchScrape(
  options: BatchScrapeCommandOptions
): Promise<BatchScrapeResult> {
  try {
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
    const { jobId, urls, timeout } = options;

    if ((options.cancel || options.status) && !jobId) {
      return {
        success: false,
        error: `${options.cancel ? 'Cancel' : 'Status'} mode requires a job ID`,
      };
    }

    if (options.cancel && jobId) {
      const cancelled = await app.cancelBatchScrape(jobId);
      if (!cancelled) {
        return {
          success: false,
          error: `Failed to cancel batch scrape job ${jobId}`,
        };
      }
      return { success: true, data: { id: jobId, status: 'cancelled' } };
    }

    if (jobId) {
      return { success: true, data: await app.getBatchScrapeStatus(jobId) };
    }

    if (urls.length === 0) {
      return {
        success: false,
        error:
          'At least one URL is required. Pass URLs as arguments or use --urls-file.',
      };
    }

    const batchOptions: any = {
      options: buildBatchScrapeOptions(options),
      integration: 'cli',
    };
    if (options.webhook) {
      batchOptions.webhook = options.webhook;
    }
    if (options.maxConcurrency !== undefined) {
      batchOptions.maxConcurrency = options.maxConcurrency;
    }
    if (options.ignoreInvalidUrls) {
      batchOptions.ignoreInvalidURLs = true;
    }

    if (!options.wait) {
      const response = await app.startBatchScrape(urls, batchOptions);
      return {
        success: true,
        data: {
          jobId: response.id,
          url: response.url,
          status: 'processing',
          ...(response.invalidURLs?.length
            ? { invalidURLs: response.invalidURLs }
            : {}),
        },
      };
    }

    const pollInterval = options.pollInterval ?? 2;

    if (!options.progress) {
      const job = await app.batchScrape(urls, {
        ...batchOptions,
        pollInterval,
        ...(timeout !== undefined ? { timeout } : {}),
      });
      return { success: true, data: job };
    }

    const response = await app.startBatchScrape(urls, batchOptions);
    process.stderr.write(`Batch scraping ${urls.length} URLs...\n`);
    process.stderr.write(`Job ID: ${response.id}\n`);

    const startTime = Date.now();
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));

      const status = await app.getBatchScrapeStatus(response.id, {
        autoPaginate: false,
      });
      process.stderr.write(
        `\rProgress: ${status.completed}/${status.total} pages (${status.status})`
      );

      if (TERMINAL_STATUSES.includes(status.status)) {
        process.stderr.write('\n');
        return {
          success: true,
          data: await app.getBatchScrapeStatus(response.id),
        };
      }

      if (timeout !== undefined && Date.now() - startTime > timeout * 1000) {
        process.stderr.write('\n');
        return {
          success: false,
          error: `Timeout after ${timeout} seconds. Batch scrape still in progress; check it with: firecrawl batch-scrape ${response.id}`,
        };
      }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Handle batch scrape command output
 */
export async function handleBatchScrapeCommand(
  options: BatchScrapeCommandOptions
): Promise<void> {
  const result = await executeBatchScrape(options);

  if (!result.success) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  const started = result.data && 'jobId' in result.data;
  const payload = started ? { success: true, data: result.data } : result.data;
  const outputContent = options.pretty
    ? JSON.stringify(payload, null, 2)
    : JSON.stringify(payload);

  writeOutput(outputContent, options.output, !!options.output);

  if (started) {
    process.stderr.write(
      `Check status: firecrawl batch-scrape ${result.data.jobId}\n`
    );
  }
}
