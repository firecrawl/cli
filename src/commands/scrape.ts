/**
 * Scrape command implementation
 */

import type { FormatOption } from '@mendable/firecrawl-js';
import type { ScrapeOptions, ScrapeResult } from '../types/scrape';
import { getClient } from '../utils/client';
import { updateConfig } from '../utils/config';
import { handleScrapeOutput } from '../utils/output';

/**
 * Execute the scrape command
 */
export async function executeScrape(
  options: ScrapeOptions
): Promise<ScrapeResult> {
  try {
    // Update global config if API key is provided via options
    if (options.apiKey) {
      updateConfig({ apiKey: options.apiKey });
    }

    // Get client instance (uses global config)
    const app = getClient();

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

    // Execute scrape
    const result = await app.scrape(options.url, scrapeParams);

    return {
      success: true,
      data: result,
    };
  } catch (error) {
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
