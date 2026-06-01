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

export interface ScrapeLocation {
  /** ISO 3166-1 alpha-2 country code (e.g., 'US', 'DE', 'BR') */
  country?: string;
  /** List of language codes (e.g., ['en', 'es']) */
  languages?: string[];
}

export interface ScrapeOptions {
  /** URL to scrape */
  url: string;
  /** Output format(s) - single format or array of formats */
  formats?: ScrapeFormat[];
  /** Include only main content */
  onlyMainContent?: boolean;
  /** Wait time before scraping (ms) */
  waitFor?: number;
  /** Take screenshot */
  screenshot?: boolean;
  /** Take full page screenshot */
  fullPageScreenshot?: boolean;
  /** Include tags */
  includeTags?: string[];
  /** Exclude tags */
  excludeTags?: string[];
  /** API key for Firecrawl */
  apiKey?: string;
  /** API URL for Firecrawl */
  apiUrl?: string;
  /** Output file path */
  output?: string;
  /** Pretty print JSON output */
  pretty?: boolean;
  /** Force JSON output */
  json?: boolean;
  /** Show request timing and other useful information */
  timing?: boolean;
  /** Maximum age of cached content in milliseconds (API-level caching) */
  maxAge?: number;
  /** Location settings for geo-targeted scraping */
  location?: ScrapeLocation;
  /** Question to ask about the page content (query format) */
  query?: string;
  /** JSON schema for json format */
  schema?: Record<string, unknown>;
  /** Actions to run during scrape */
  actions?: Record<string, unknown>[];
  /** Proxy mode */
  proxy?: string;
  /** Persistent browser profile for maintaining state across scrapes */
  profile?: {
    name: string;
    saveChanges?: boolean;
  };
  /** Enable lockdown mode for the scrape */
  lockdown?: boolean;
  /** Redact personally identifiable information from returned content */
  redactPII?: boolean;
}

export interface ScrapeResult {
  success: boolean;
  data?: any;
  error?: string;
}
