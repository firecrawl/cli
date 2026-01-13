/**
 * Types and interfaces for the scrape command
 */

export type ScrapeFormat =
  | 'markdown'
  | 'html'
  | 'rawHtml'
  | 'links'
  | 'images'
  | 'screenshot'
  | 'summary'
  | 'changeTracking'
  | 'json'
  | 'attributes'
  | 'branding';

export interface ScrapeOptions {
  /** URL to scrape */
  url: string;
  /** Output format (markdown, html, etc.) */
  format?: ScrapeFormat;
  /** Include only main content */
  onlyMainContent?: boolean;
  /** Wait time before scraping (ms) */
  waitFor?: number;
  /** Take screenshot */
  screenshot?: boolean;
  /** Include tags */
  includeTags?: string[];
  /** Exclude tags */
  excludeTags?: string[];
  /** API key for Firecrawl */
  apiKey?: string;
  /** Output file path */
  output?: string;
  /** Pretty print JSON output */
  pretty?: boolean;
  /** Show request timing and other useful information */
  timing?: boolean;
}

export interface ScrapeResult {
  success: boolean;
  data?: any;
  error?: string;
}
