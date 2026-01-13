/**
 * Option parsing utilities
 */

import type { ScrapeOptions } from '../types/scrape';

/**
 * Convert commander options to ScrapeOptions
 */
export function parseScrapeOptions(options: any): ScrapeOptions {
  return {
    url: options.url,
    format: options.format,
    onlyMainContent: options.onlyMainContent,
    waitFor: options.waitFor,
    screenshot: options.screenshot,
    includeTags: options.includeTags
      ? options.includeTags.split(',').map((t: string) => t.trim())
      : undefined,
    excludeTags: options.excludeTags
      ? options.excludeTags.split(',').map((t: string) => t.trim())
      : undefined,
    apiKey: options.apiKey,
    output: options.output,
    pretty: options.pretty,
    timing: options.timing,
  };
}
