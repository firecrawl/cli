/**
 * Option parsing utilities
 */

import type { ScrapeOptions, ScrapeFormat } from '../types/scrape';

/**
 * Valid scrape format values
 */
const VALID_FORMATS: ScrapeFormat[] = [
  'markdown',
  'html',
  'rawHtml',
  'links',
  'images',
  'screenshot',
  'summary',
  'changeTracking',
  'json',
  'attributes',
  'branding',
];

/**
 * Map from lowercase to correct camelCase format
 */
const FORMAT_MAP: Record<string, ScrapeFormat> = Object.fromEntries(
  VALID_FORMATS.map((f) => [f.toLowerCase(), f])
) as Record<string, ScrapeFormat>;

/**
 * Parse format string into array of ScrapeFormat
 * Handles comma-separated values: "markdown,links,images"
 * Case-insensitive input, returns correct camelCase for API
 */
export function parseFormats(formatString: string): ScrapeFormat[] {
  const inputFormats = formatString
    .split(',')
    .map((f) => f.trim().toLowerCase())
    .filter((f) => f.length > 0);

  // Validate and map to correct casing
  const invalidFormats: string[] = [];
  const validFormats: ScrapeFormat[] = [];

  for (const input of inputFormats) {
    const mapped = FORMAT_MAP[input];
    if (mapped) {
      validFormats.push(mapped);
    } else {
      invalidFormats.push(input);
    }
  }

  if (invalidFormats.length > 0) {
    throw new Error(
      `Invalid format(s): ${invalidFormats.join(', ')}. Valid formats are: ${VALID_FORMATS.join(', ')}`
    );
  }

  // Remove duplicates while preserving order
  return [...new Set(validFormats)];
}

/**
 * Convert commander options to ScrapeOptions
 */
export function parseScrapeOptions(options: any): ScrapeOptions {
  // Parse formats from comma-separated string
  let formats: ScrapeFormat[] | undefined;
  if (options.format) {
    formats = parseFormats(options.format);
  }

  return {
    url: options.url,
    formats,
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
    apiUrl: options.apiUrl,
    output: options.output,
    pretty: options.pretty,
    json: options.json,
    timing: options.timing,
  };
}
