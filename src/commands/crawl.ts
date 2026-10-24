/**
 * Crawl command implementation
 */

import type { CrawlOptions, CrawlResult } from '../types/crawl';
import { getClient } from '../utils/client';
import { isJobId } from '../utils/job';
import { writeOutput } from '../utils/output';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Execute crawl command
 */
export async function executeCrawl(
  options: CrawlOptions
): Promise<CrawlResult> {
  try {
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
    const { urlOrJobId, status, wait, pollInterval, timeout, cancel } = options;

    if (cancel) {
      if (!isJobId(urlOrJobId)) {
        return {
          success: false,
          error: 'Cancel mode requires a job ID',
        };
      }

      const cancelled = await app.cancelCrawl(urlOrJobId);
      if (!cancelled) {
        return {
          success: false,
          error: `Failed to cancel crawl job ${urlOrJobId}`,
        };
      }

      return {
        success: true,
        data: {
          id: urlOrJobId,
          status: 'cancelled',
          total: 0,
          completed: 0,
        },
      };
    }

    // A job ID returns the job's status and pages; with --wait, poll it to the end
    if (status || isJobId(urlOrJobId)) {
      const pollMs = (pollInterval ?? 5) * 1000;
      const startTime = Date.now();
      while (true) {
        const job = await app.getCrawlStatus(urlOrJobId);
        if (!wait || TERMINAL_STATUSES.has(job.status)) {
          return { success: true, data: job };
        }
        if (timeout !== undefined && Date.now() - startTime > timeout * 1000) {
          return {
            success: false,
            error: `Timeout after ${timeout} seconds. Crawl still in progress. Resume with: firecrawl crawl ${urlOrJobId} --wait`,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }

    // Build crawl options
    const crawlOptions: any = {
      integration: 'cli',
    };

    if (options.limit !== undefined) {
      crawlOptions.limit = options.limit;
    }
    if (options.maxDepth !== undefined) {
      crawlOptions.maxDiscoveryDepth = options.maxDepth;
    }
    if (options.excludePaths && options.excludePaths.length > 0) {
      crawlOptions.excludePaths = options.excludePaths;
    }
    if (options.includePaths && options.includePaths.length > 0) {
      crawlOptions.includePaths = options.includePaths;
    }
    if (options.sitemap) {
      crawlOptions.sitemap = options.sitemap;
    }
    if (options.ignoreQueryParameters !== undefined) {
      crawlOptions.ignoreQueryParameters = options.ignoreQueryParameters;
    }
    if (options.crawlEntireDomain !== undefined) {
      crawlOptions.crawlEntireDomain = options.crawlEntireDomain;
    }
    if (options.allowExternalLinks !== undefined) {
      crawlOptions.allowExternalLinks = options.allowExternalLinks;
    }
    if (options.allowSubdomains !== undefined) {
      crawlOptions.allowSubdomains = options.allowSubdomains;
    }
    if (options.delay !== undefined) {
      crawlOptions.delay = options.delay;
    }
    if (options.maxConcurrency !== undefined) {
      crawlOptions.maxConcurrency = options.maxConcurrency;
    }

    if (options.scrapeOptions) {
      crawlOptions.scrapeOptions = options.scrapeOptions;
    }

    if (options.webhook) {
      crawlOptions.webhook = options.webhook;
    }

    // If wait mode, use the convenience crawl method with polling
    if (wait) {
      const waiterOptions = {
        pollInterval: pollInterval ?? 5,
        ...(timeout !== undefined ? { timeout } : {}),
      };

      // Show progress if requested - use custom polling for better UX
      if (options.progress) {
        // Start crawl first
        const response = await app.startCrawl(urlOrJobId, crawlOptions);
        const jobId = response.id;

        process.stderr.write(`Crawling ${urlOrJobId}...\n`);
        process.stderr.write(`Job ID: ${jobId}\n`);

        // Poll for status with progress updates
        const pollMs = waiterOptions.pollInterval * 1000;
        const startTime = Date.now();
        const timeoutMs = timeout !== undefined ? timeout * 1000 : undefined;

        while (true) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));

          const status = await app.getCrawlStatus(jobId);

          // Show progress
          process.stderr.write(
            `\rProgress: ${status.completed}/${status.total} pages (${status.status})`
          );

          if (TERMINAL_STATUSES.has(status.status)) {
            process.stderr.write('\n');
            return {
              success: true,
              data: status,
            };
          }

          // Check timeout
          if (timeoutMs && Date.now() - startTime > timeoutMs) {
            process.stderr.write('\n');
            return {
              success: false,
              error: `Timeout after ${timeout} seconds. Crawl still in progress.`,
            };
          }
        }
      } else {
        // Use SDK's built-in polling (no progress display)
        const crawlJob = await app.crawl(urlOrJobId, {
          ...crawlOptions,
          ...waiterOptions,
        });
        return {
          success: true,
          data: crawlJob,
        };
      }
    }

    // Otherwise, start crawl and return job ID
    const response = await app.startCrawl(urlOrJobId, crawlOptions);

    return {
      success: true,
      data: {
        jobId: response.id,
        url: response.url,
        status: 'processing',
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Handle crawl command output
 */
export async function handleCrawlCommand(options: CrawlOptions): Promise<void> {
  const result = await executeCrawl(options);

  if (!result.success) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  // Handle crawl result (job ID, job status, or completed crawl)
  const crawlResult = result;
  if (!crawlResult.data) {
    return;
  }

  let outputContent: string;

  // If it's a job ID response (has jobId field)
  if ('jobId' in crawlResult.data) {
    const jobData = {
      jobId: crawlResult.data.jobId,
      url: crawlResult.data.url,
      status: crawlResult.data.status,
    };

    outputContent = options.pretty
      ? JSON.stringify({ success: true, data: jobData }, null, 2)
      : JSON.stringify({ success: true, data: jobData });
  } else {
    // Completed crawl - output the data
    // For completed crawls, output as JSON
    outputContent = options.pretty
      ? JSON.stringify(crawlResult.data, null, 2)
      : JSON.stringify(crawlResult.data);
  }

  writeOutput(outputContent, options.output, !!options.output);

  const finalStatus = crawlResult.data.status;
  if (
    options.wait &&
    (finalStatus === 'failed' || finalStatus === 'cancelled')
  ) {
    console.error(`Error: Crawl ${finalStatus}.`);
    process.exitCode = 1;
  }
}
