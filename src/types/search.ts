/**
 * Types for search command
 */

import type { ScrapeFormat } from './scrape';

export type SearchSource = 'web' | 'images' | 'news' | 'exchange';
export type SearchCategory = 'github' | 'research' | 'pdf';

/** One Exchange capability to execute. */
export interface ExchangeCall {
  provider: string;
  capability: string;
  options: Record<string, unknown>;
  providerApiKey?: string;
}

export interface SearchOptions {
  /** Search query. Optional when only browsing or calling Exchange providers */
  query?: string;
  /** API key for Firecrawl */
  apiKey?: string;
  /** API URL for Firecrawl */
  apiUrl?: string;
  /** Maximum number of results (default: 5, max: 100) */
  limit?: number;
  /** Sources to search: web, images, news, exchange (default: web) */
  sources?: SearchSource[];
  /** Limit Exchange discovery to provider cohorts */
  exchangeCategories?: string[];
  /** Limit Exchange discovery to named providers */
  exchangeProviders?: string[];
  /** Limit Exchange discovery to specific provider/capability pairs */
  exchangeCapabilities?: string[];
  /** Exchange capabilities to execute */
  exchange?: ExchangeCall[];
  /** Categories to filter results: github, research, pdf */
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

/** A capability discovered via `--sources exchange`. */
export interface ExchangeProviderResult {
  url: string;
  title?: string;
  description?: string;
  provider: string;
  capability: string;
  creditsPerCall?: number;
}

/** The outcome of one executed Exchange capability. */
export interface ExchangeCallResult {
  provider: string;
  capability: string;
  delivery?: string;
  creditsCost?: number;
  data?: unknown;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
  };
}

export interface SearchResultData {
  web?: WebSearchResult[];
  images?: ImageSearchResult[];
  news?: NewsSearchResult[];
  providers?: ExchangeProviderResult[];
  exchange?: ExchangeCallResult[];
}

export interface SearchResult {
  success: boolean;
  data?: SearchResultData;
  warning?: string;
  id?: string;
  creditsUsed?: number;
  error?: string;
}
