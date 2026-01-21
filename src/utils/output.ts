/**
 * Output utilities for CLI
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ScrapeResult, ScrapeFormat } from '../types/scrape';

/**
 * Text formats that can be output as raw content (curl-like)
 */
const RAW_TEXT_FORMATS: ScrapeFormat[] = [
  'html',
  'rawHtml',
  'markdown',
  'links',
  'images',
  'summary',
];

/**
 * Format screenshot output nicely
 */
function formatScreenshotOutput(data: any): string {
  const lines: string[] = [];

  // Screenshot URL
  if (data.screenshot) {
    lines.push(`Screenshot: ${data.screenshot}`);
  }

  // Page info from metadata
  if (data.metadata) {
    if (data.metadata.title) {
      lines.push(`Title: ${data.metadata.title}`);
    }
    if (data.metadata.sourceURL || data.metadata.url) {
      lines.push(`URL: ${data.metadata.sourceURL || data.metadata.url}`);
    }
    if (data.metadata.description) {
      lines.push(`Description: ${data.metadata.description}`);
    }
  }

  return lines.join('\n');
}

/**
 * Extract content from Firecrawl Document based on format
 */
function extractContent(data: any, format: ScrapeFormat): string | null {
  if (!data) return null;

  // Handle html/rawHtml formats - extract HTML content directly
  if (format === 'html' || format === 'rawHtml') {
    return data.html || data.rawHtml || data[format] || null;
  }

  // Handle markdown format
  if (format === 'markdown') {
    return data.markdown || data[format] || null;
  }

  // Handle links format (array of URLs -> newline-separated string)
  if (format === 'links') {
    const links = data.links || data[format];
    if (Array.isArray(links)) {
      return links.join('\n');
    }
    return links || null;
  }

  // Handle images format (array of URLs -> newline-separated string)
  if (format === 'images') {
    const images = data.images || data[format];
    if (Array.isArray(images)) {
      return images.join('\n');
    }
    return images || null;
  }

  // Handle summary format
  if (format === 'summary') {
    return data.summary || data[format] || null;
  }

  return null;
}

/**
 * Extract multiple format contents from response data
 */
function extractMultipleFormats(
  data: any,
  formats: ScrapeFormat[]
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const format of formats) {
    const key = format;

    if (data[key] !== undefined) {
      result[key] = data[key];
    } else if (format === 'html' && data.rawHtml !== undefined) {
      // Fallback for html -> rawHtml
      result[key] = data.rawHtml;
    } else if (format === 'rawHtml' && data.html !== undefined) {
      // Fallback for rawHtml -> html
      result[key] = data.html;
    }
  }

  // Always include metadata if present
  if (data.metadata) {
    result.metadata = data.metadata;
  }

  return result;
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
 *
 * Output behavior:
 * - Single text format (html, markdown, links, images, summary, rawHtml): raw content
 * - Single complex format (screenshot, json, branding, etc.): JSON output
 * - Multiple formats: JSON with all requested data
 */
export function handleScrapeOutput(
  result: ScrapeResult,
  formats: ScrapeFormat[],
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

  // Determine output mode based on number of formats
  const isSingleFormat = formats.length === 1;
  const singleFormat = isSingleFormat ? formats[0] : null;
  const isRawTextFormat =
    singleFormat && RAW_TEXT_FORMATS.includes(singleFormat);

  // Single raw text format: output raw content (current behavior)
  if (isSingleFormat && isRawTextFormat && singleFormat) {
    const content = extractContent(result.data, singleFormat);
    if (content !== null) {
      writeOutput(content, outputPath, !!outputPath);
      return;
    }
  }

  // Single screenshot format: output nicely formatted
  if (
    isSingleFormat &&
    singleFormat === 'screenshot' &&
    result.data.screenshot
  ) {
    const content = formatScreenshotOutput(result.data);
    writeOutput(content, outputPath, !!outputPath);
    return;
  }

  // Multiple formats or complex format: output JSON
  let outputData: any;

  if (isSingleFormat) {
    // Single complex format - output entire data object
    outputData = result.data;
  } else {
    // Multiple formats - extract only requested formats
    outputData = extractMultipleFormats(result.data, formats);
  }

  let jsonContent: string;
  try {
    jsonContent = pretty
      ? JSON.stringify(outputData, null, 2)
      : JSON.stringify(outputData);
  } catch (error) {
    jsonContent = JSON.stringify({
      error: 'Failed to serialize response',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  writeOutput(jsonContent, outputPath, !!outputPath);
}
