/**
 * Scrape command implementation
 */

import type { FormatOption } from '@mendable/firecrawl-js';
import type { ScrapeOptions, ScrapeResult } from '../types/scrape';
import { getClient } from '../utils/client';
import { handleScrapeOutput } from '../utils/output';

/**
 * Output timing information if requested
 */
function outputTiming(
  options: ScrapeOptions,
  requestStartTime: number,
  requestEndTime: number,
  error?: Error | unknown
): void {
  if (!options.timing) return;

  const requestDuration = requestEndTime - requestStartTime;
  const timingInfo: {
    url: string;
    requestTime: string;
    duration: string;
    status: 'success' | 'error';
    error?: string;
  } = {
    url: options.url,
    requestTime: new Date(requestStartTime).toISOString(),
    duration: `${requestDuration}ms`,
    status: error ? 'error' : 'success',
  };

  if (error) {
    timingInfo.error = error instanceof Error ? error.message : 'Unknown error';
  }

  console.error('Timing:', JSON.stringify(timingInfo, null, 2));
}

/**
 * Execute the scrape command
 */
export async function executeScrape(
  options: ScrapeOptions
): Promise<ScrapeResult> {
  // Get client instance (updates global config if apiKey provided)
  const app = getClient({ apiKey: options.apiKey });

  // Build scrape options
  const formats: FormatOption[] = [];

  if (options.format) {
    formats.push(options.format);
  }

  if (options.screenshot) {
    // Add screenshot format if not already included
    if (!formats.includes('screenshot')) {
      formats.push('screenshot');
    }
  }

  // If no formats specified, default to markdown
  if (formats.length === 0) {
    formats.push('markdown');
  }

  const scrapeParams: {
    formats?: FormatOption[];
    onlyMainContent?: boolean;
    waitFor?: number;
    includeTags?: string[];
    excludeTags?: string[];
  } = {
    formats,
  };

  if (options.onlyMainContent !== undefined) {
    scrapeParams.onlyMainContent = options.onlyMainContent;
  }

  if (options.waitFor !== undefined) {
    scrapeParams.waitFor = options.waitFor;
  }

  if (options.includeTags && options.includeTags.length > 0) {
    scrapeParams.includeTags = options.includeTags;
  }

  if (options.excludeTags && options.excludeTags.length > 0) {
    scrapeParams.excludeTags = options.excludeTags;
  }

  // Execute scrape with timing - only wrap the scrape call in try-catch
  const requestStartTime = Date.now();

  try {
    const result = await app.scrape(options.url, scrapeParams);
    const requestEndTime = Date.now();
    outputTiming(options, requestStartTime, requestEndTime);

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    const requestEndTime = Date.now();
    outputTiming(options, requestStartTime, requestEndTime, error);

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Handle scrape command output
 */
export async function handleScrapeCommand(
  options: ScrapeOptions
): Promise<void> {
  const result = await executeScrape(options);
  handleScrapeOutput(result, options.format, options.output, options.pretty);
}
