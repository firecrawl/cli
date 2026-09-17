/**
 * Option parsing utilities
 */

import { InvalidArgumentError } from 'commander';
import type {
  ScrapeOptions,
  ScrapeFormat,
  ScrapeLocation,
} from '../types/scrape';

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

export function parseMaxPages(value: string): number {
  const pages = Number(value);
  if (
    !/^\d+$/.test(value) ||
    !Number.isInteger(pages) ||
    pages < 1 ||
    pages > 10000
  ) {
    throw new InvalidArgumentError('must be an integer between 1 and 10000');
  }
  return pages;
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

  // Build location object if country or languages are provided
  let location: ScrapeLocation | undefined;
  if (options.country || options.languages) {
    location = {};
    if (options.country) {
      location.country = options.country;
    }
    if (options.languages) {
      location.languages = options.languages
        .split(',')
        .map((l: string) => l.trim());
    }
  }

  let profile: { name: string; saveChanges?: boolean } | undefined;
  if (options.profile) {
    profile = {
      name: options.profile,
      saveChanges: options.saveChanges,
    };
  }

  return {
    url: options.url,
    domainTools: options.domainTools,
    formats,
    onlyMainContent: options.onlyMainContent,
    waitFor: options.waitFor,
    timeout: options.timeout,
    screenshot: options.screenshot,
    fullPageScreenshot: options.fullPageScreenshot,
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
    maxAge: options.maxAge,
    maxPages: options.maxPages,
    location,
    query: options.query,
    profile,
    lockdown: options.lockdown,
    redactPII: options.redactPii ?? options.redactPII,
  };
}

export function parseScrapeTimeout(value: string): number {
  const timeout = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new InvalidArgumentError(
      '--timeout must be a positive integer in milliseconds.'
    );
  }
  return timeout;
}
