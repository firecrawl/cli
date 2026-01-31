/**
 * Types for search command
 */

import type { ScrapeFormat } from './scrape';

export type SearchSource = 'web' | 'images' | 'news';
export type SearchCategory = 'github' | 'research' | 'pdf';

export interface SearchOptions {
  /** Search query (required) */
  query: string;
  /** API key for Firecrawl */
  apiKey?: string;
  /** API URL for Firecrawl */
  apiUrl?: string;
  /** Maximum number of results (default: 5, max: 100) */
  limit?: number;
  /** Sources to search: web, images, news (default: web) */
  sources?: SearchSource[];
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

export interface SearchResultData {
  web?: WebSearchResult[];
  images?: ImageSearchResult[];
  news?: NewsSearchResult[];
}

export interface SearchResult {
  success: boolean;
  data?: SearchResultData;
  warning?: string;
  id?: string;
  creditsUsed?: number;
  error?: string;
}
