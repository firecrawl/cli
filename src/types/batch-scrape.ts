/**
 * Types for batch-scrape command
 */

export interface BatchScrapeCommandOptions {
  /** API key for Firecrawl */
  apiKey?: string;
  /** API URL for Firecrawl */
  apiUrl?: string;
  /** URLs to scrape (ignored when jobId is set) */
  urls?: string[];
  /** Existing batch scrape job ID for status checks or cancellation */
  jobId?: string;
  /** Check status of an existing batch scrape job */
  status?: boolean;
  /** Cancel an existing batch scrape job */
  cancel?: boolean;
  /** Wait for the batch scrape to complete */
  wait?: boolean;
  /** Polling interval in seconds when waiting */
  pollInterval?: number;
  /** Timeout in seconds when waiting */
  timeout?: number;
  /** Show progress while waiting */
  progress?: boolean;
  /** Output file path */
  output?: string;
  /** Pretty print JSON output */
  pretty?: boolean;
  /** Comma-separated output formats */
  format?: string;
  /** Include only main content */
  onlyMainContent?: boolean;
  /** Wait time before scraping (ms) */
  waitFor?: number;
  /** Maximum age of cached content (ms) */
  maxAge?: number;
  /** JSON schema for the json format */
  schema?: Record<string, unknown>;
  /** Extraction prompt for the json format */
  prompt?: string;
  /** Scrape options applied to every URL, overridden by explicit flags */
  scrapeOptions?: Record<string, unknown>;
  /** Webhook URL or webhook config */
  webhook?: string | Record<string, unknown>;
  /** Maximum concurrent scrapes for this job */
  maxConcurrency?: number;
  /** Skip invalid URLs instead of failing the whole job */
  ignoreInvalidUrls?: boolean;
}

export interface BatchScrapeResult {
  success: boolean;
  data?: any;
  error?: string;
}
