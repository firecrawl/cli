/**
 * Types for search command
 */

import type { ScrapeFormat } from './scrape';

export type SearchSource = 'web' | 'images' | 'news' | 'alexandria';
export type SearchCategory = 'research' | 'pdf' | 'developer';

export interface SearchOptions {
  domainTools?: boolean;
  toolDetail?: 'compact' | 'summary' | 'full';
  /** Search query (required) */
  query: string;
  /** API key for Firecrawl */
  apiKey?: string;
  /** API URL for Firecrawl */
  apiUrl?: string;
  /** Maximum number of results (default: 5, max: 100) */
  limit?: number;
  /** Sources to search: web, images, news, alexandria (CLI default: web,alexandria) */
  sources?: SearchSource[];
  /** Categories to filter results: research, pdf, developer */
  categories?: SearchCategory[];
  /** Time-based search parameter (e.g., qdr:h, qdr:d, qdr:w, qdr:m, qdr:y) */
  tbs?: string;
  /** Location for geo-targeting (e.g., "Germany", "San Francisco,California,United States") */
  location?: string;
  /** ISO country code for geo-targeting (default: US) */
  country?: string;
  /** Timeout in milliseconds (default: 60000) */
  timeout?: number;
  /** Exclude URLs invalid for other Firecrawl endpoints */
  ignoreInvalidUrls?: boolean;
  /** Return query-relevant highlights instead of the original search snippets */
  highlights?: boolean;
  /** Output file path */
  output?: string;
  /** Output as JSON format */
  json?: boolean;
  /** Pretty print JSON output */
  pretty?: boolean;
  /** Enable scraping of search results */
  scrape?: boolean;
  /** Scrape formats when scraping is enabled */
  scrapeFormats?: ScrapeFormat[];
  /** Only main content when scraping */
  onlyMainContent?: boolean;
}

export interface WebSearchResult {
  url: string;
  title?: string;
  description?: string;
  position?: number;
  category?: string;
  /** Included when scraping is enabled */
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  screenshot?: string;
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    statusCode?: number;
    error?: string | null;
  };
}

export interface ImageSearchResult {
  title?: string;
  imageUrl: string;
  imageWidth?: number;
  imageHeight?: number;
  url: string;
  position?: number;
}

export interface NewsSearchResult {
  title?: string;
  snippet?: string;
  url: string;
  date?: string;
  imageUrl?: string;
  position?: number;
  /** Included when scraping is enabled */
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  screenshot?: string;
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    statusCode?: number;
    error?: string | null;
  };
}

/**
 * One hit from the `developer` category. The index covers public repositories,
 * GitHub issues, merged pull requests, repository READMEs, and curated
 * documentation sites.
 * `description` holds the matched passage, which runs to several KB.
 */
export interface DeveloperSearchResult {
  url: string;
  title?: string;
  description?: string;
  position?: number;
  category?: string;
}

export interface SearchResultData {
  tools?: Record<string, unknown>[];
  web?: WebSearchResult[];
  images?: ImageSearchResult[];
  news?: NewsSearchResult[];
  /** Present when the `developer` category is requested. */
  developer?: DeveloperSearchResult[];
}

export interface SearchResult {
  success: boolean;
  data?: SearchResultData;
  warning?: string;
  id?: string;
  creditsUsed?: number;
  error?: string;
}
