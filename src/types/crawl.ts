/**
 * Types for crawl command
 */

export interface CrawlOptions {
  /** API key for Firecrawl */
  apiKey?: string;
  /** API URL for Firecrawl */
  apiUrl?: string;
  /** URL to crawl or job ID to check status */
  urlOrJobId: string;
  /** Check status of existing crawl job */
  status?: boolean;
  /** Wait for crawl to complete */
  wait?: boolean;
  /** Polling interval in seconds when waiting */
  pollInterval?: number;
  /** Timeout in seconds when waiting */
  timeout?: number;
  /** Show progress dots while waiting */
  progress?: boolean;
  /** Output file path */
  output?: string;
  /** Pretty print JSON output */
  pretty?: boolean;
  /** Maximum number of pages to crawl */
  limit?: number;
  /** Maximum crawl depth */
  maxDepth?: number;
  /** Exclude paths */
  excludePaths?: string[];
  /** Include paths */
  includePaths?: string[];
  /** Sitemap handling */
  sitemap?: 'skip' | 'include';
  /** Ignore query parameters */
  ignoreQueryParameters?: boolean;
  /** Crawl entire domain */
  crawlEntireDomain?: boolean;
  /** Allow external links */
  allowExternalLinks?: boolean;
  /** Allow subdomains */
  allowSubdomains?: boolean;
  /** Delay between requests */
  delay?: number;
  /** Maximum concurrency */
  maxConcurrency?: number;
  /** Maximum age of cached content in milliseconds (API-level caching) */
  maxAge?: number;
  /** Include only main content */
  onlyMainContent?: boolean;
}

export interface CrawlResult {
  success: boolean;
  data?: any;
  error?: string;
}

export interface CrawlStatusResult {
  success: boolean;
  data?: {
    id: string;
    status: 'scraping' | 'completed' | 'failed' | 'cancelled';
    total: number;
    completed: number;
    creditsUsed?: number;
    expiresAt?: string;
  };
  error?: string;
}
