/**
 * Types for map command
 */

export interface MapOptions {
  /** API key for Firecrawl */
  apiKey?: string;
  /** API URL for Firecrawl */
  apiUrl?: string;
  /** URL to map or job ID to check status */
  urlOrJobId: string;
  /** Check status of existing map job */
  status?: boolean;
  /** Wait for map to complete */
  wait?: boolean;
  /** Output file path */
  output?: string;
  /** Output as JSON format */
  json?: boolean;
  /** Pretty print JSON output */
  pretty?: boolean;
  /** Maximum URLs to discover */
  limit?: number;
  /** Search query */
  search?: string;
  /** Sitemap handling */
  sitemap?: 'only' | 'include' | 'skip';
  /** Include subdomains */
  includeSubdomains?: boolean;
  /** Ignore query parameters */
  ignoreQueryParameters?: boolean;
  /** Timeout in seconds */
  timeout?: number;
}

export interface MapResult {
  success: boolean;
  data?: {
    links: Array<{
      url: string;
      title?: string;
      description?: string;
    }>;
  };
  error?: string;
}
