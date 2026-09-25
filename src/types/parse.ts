/**
 * Types and interfaces for the parse command
 */

import type { ScrapeFormat, ScrapeLocation } from './scrape';
import type { AgentHintMetadata, AgentHintOptions } from '../utils/agent-hints';

export interface ParseOptions extends AgentHintOptions {
  /** Local file path to parse */
  file: string;
  /** Output format(s) */
  formats?: ScrapeFormat[];
  /** Include only main content */
  onlyMainContent?: boolean;
  /** Include tags */
  includeTags?: string[];
  /** Exclude tags */
  excludeTags?: string[];
  /** Timeout in milliseconds for the parse job */
  timeout?: number;
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
  /** Show request timing */
  timing?: boolean;
  /** Location for geo-targeted parsing (typically unused for local files) */
  location?: ScrapeLocation;
  /** Ask a question about the parsed content (query format) */
  query?: string;
}

export interface ParseResult extends AgentHintMetadata {
  success: boolean;
  data?: any;
  error?: string;
}
