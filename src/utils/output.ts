/**
 * Output utilities for CLI
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ScrapeResult } from '../types/scrape';
import type { ScrapeFormat } from '../types/scrape';

/**
 * Extract content from Firecrawl Document based on format
 */
function extractContent(data: any, format?: ScrapeFormat): string | null {
  if (!data) return null;

  // If format is specified, try to extract that specific content
  if (format) {
    // Handle html/rawHtml formats - extract HTML content directly
    if (format === 'html' || format === 'rawHtml') {
      return data.html || data.rawHtml || data[format] || null;
    }

    // Handle markdown format
    if (format === 'markdown') {
      return data.markdown || data[format] || null;
    }

    // Handle links format
    if (format === 'links') {
      return data.links || data[format] || null;
    }

    // Handle images format
    if (format === 'images') {
      return data.images || data[format] || null;
    }

    // Handle summary format
    if (format === 'summary') {
      return data.summary || data[format] || null;
    }
  }

  // Fallback: try common content fields
  if (typeof data === 'string') {
    return data;
  }

  // If it's an object, try to find string content
  if (typeof data === 'object') {
    return data.html || data.markdown || data.rawHtml || data.content || null;
  }

  return null;
}

/**
 * Write output to file or stdout
 */
export function writeOutput(
  content: string,
  outputPath?: string,
  silent: boolean = false
): void {
  if (outputPath) {
    const dir = path.dirname(outputPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, content, 'utf-8');
    if (!silent) {
      // Always use stderr for file confirmation messages
      console.error(`Output written to: ${outputPath}`);
    }
  } else {
    // Use process.stdout.write for raw output (like curl)
    // Ensure content ends with newline for proper piping
    if (!content.endsWith('\n')) {
      content += '\n';
    }
    process.stdout.write(content);
  }
}

/**
 * Handle scrape result output
 * For text formats (html, markdown, etc.), outputs raw content directly
 * For complex formats, outputs JSON
 */
export function handleScrapeOutput(
  result: ScrapeResult,
  format?: ScrapeFormat,
  outputPath?: string,
  pretty: boolean = false
): void {
  if (!result.success) {
    // Always use stderr for errors to allow piping
    console.error('Error:', result.error);
    process.exit(1);
  }

  if (!result.data) {
    return;
  }

  // Text formats that should output raw content (curl-like)
  const rawTextFormats: ScrapeFormat[] = [
    'html',
    'rawHtml',
    'markdown',
    'links',
    'images',
    'summary',
  ];
  const shouldOutputRaw = format && rawTextFormats.includes(format);

  if (shouldOutputRaw) {
    // Extract and output raw content
    const content = extractContent(result.data, format);
    if (content !== null) {
      writeOutput(content, outputPath, !!outputPath);
      return;
    }
  }

  // For JSON format or complex formats (branding, json, etc.), output clean JSON
  // Always stringify the entire data object to ensure valid JSON
  let jsonContent: string;
  try {
    jsonContent = pretty
      ? JSON.stringify(result.data, null, 2)
      : JSON.stringify(result.data);
  } catch (error) {
    // If stringification fails, try to create a minimal error response
    jsonContent = JSON.stringify({
      error: 'Failed to serialize response',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  // Ensure clean JSON output (no extra newlines or text before JSON)
  // Output directly to stdout without any prefix
  writeOutput(jsonContent, outputPath, !!outputPath);
}
