/**
 * Parse command implementation
 *
 * Uploads a local file to the Firecrawl /v2/parse endpoint and returns the
 * parsed document in the requested format(s). Supported file types:
 *   .html, .htm, .pdf, .docx, .doc, .odt, .rtf, .xlsx, .xls
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FormatOption } from 'firecrawl';
import type { ParseOptions, ParseResult } from '../types/parse';
import type { ScrapeFormat } from '../types/scrape';
import { getClient } from '../utils/client';
import { getConfig, validateConfig } from '../utils/config';
import { handleScrapeOutput } from '../utils/output';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';

/** File extensions accepted by /v2/parse (mirrors the API controller). */
const SUPPORTED_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.pdf',
  '.docx',
  '.doc',
  '.odt',
  '.rtf',
  '.xlsx',
  '.xls',
]);

/**
 * Best-effort content-type lookup so the API's kind detector has a hint
 * even if the extension is ambiguous.
 */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.rtf': 'application/rtf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};

function outputTiming(
  options: ParseOptions,
  requestStartTime: number,
  requestEndTime: number,
  error?: Error | unknown
): void {
  if (!options.timing) return;

  const duration = requestEndTime - requestStartTime;
  const info: Record<string, string> = {
    file: options.file,
    requestTime: new Date(requestStartTime).toISOString(),
    duration: `${duration}ms`,
    status: error ? 'error' : 'success',
  };
  if (error) {
    info.error = error instanceof Error ? error.message : 'Unknown error';
  }
  console.error('Timing:', JSON.stringify(info, null, 2));
}

/**
 * Build the `formats` array sent to the API (mirrors scrape's behavior).
 */
function buildFormats(options: ParseOptions): FormatOption[] {
  const formats: FormatOption[] = [];

  if (options.formats && options.formats.length > 0) {
    formats.push(...options.formats);
  }

  if (options.query) {
    formats.push({ type: 'query', prompt: options.query } as any);
  }

  if (formats.length === 0) {
    formats.push('markdown');
  }

  return formats;
}

/**
 * Build the JSON `options` payload uploaded alongside the file.
 */
function buildOptionsPayload(options: ParseOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    formats: buildFormats(options),
    integration: 'cli',
  };

  if (options.onlyMainContent !== undefined) {
    payload.onlyMainContent = options.onlyMainContent;
  }
  if (options.includeTags && options.includeTags.length > 0) {
    payload.includeTags = options.includeTags;
  }
  if (options.excludeTags && options.excludeTags.length > 0) {
    payload.excludeTags = options.excludeTags;
  }
  if (options.timeout !== undefined) {
    payload.timeout = options.timeout;
  }
  if (options.location) {
    payload.location = options.location;
  }

  return payload;
}

/**
 * Execute the parse command by POSTing a multipart upload to /v2/parse.
 */
export async function executeParse(
  options: ParseOptions
): Promise<ParseResult> {
  const filePath = path.resolve(options.file);

  if (!fs.existsSync(filePath)) {
    return {
      success: false,
      error: `File not found: ${options.file}`,
    };
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return {
      success: false,
      error: `Not a file: ${options.file}`,
    };
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return {
      success: false,
      error:
        `Unsupported file type "${ext || '(none)'}". ` +
        `Supported extensions: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
    };
  }

  // Ensure auth/url is resolved through the same config pipeline scrape uses.
  if (options.apiKey || options.apiUrl) {
    getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
  }

  const config = getConfig();
  const apiKey = options.apiKey || config.apiKey;
  validateConfig(apiKey);

  const apiUrl = (options.apiUrl || config.apiUrl || DEFAULT_API_URL).replace(
    /\/$/,
    ''
  );

  const buffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const contentType = CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream';

  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(buffer)], { type: contentType }),
    filename
  );
  form.append('options', JSON.stringify(buildOptionsPayload(options)));

  const requestStartTime = Date.now();

  try {
    const response = await fetch(`${apiUrl}/v2/parse`, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: form,
    });

    const requestEndTime = Date.now();
    outputTiming(options, requestStartTime, requestEndTime);

    const payload = (await response.json().catch(() => ({}))) as any;

    if (!response.ok || payload?.success === false) {
      const message =
        payload?.error ||
        `HTTP ${response.status}: ${response.statusText || 'Request failed'}`;
      return { success: false, error: message };
    }

    return {
      success: true,
      data: payload?.data ?? payload,
    };
  } catch (error) {
    const requestEndTime = Date.now();
    outputTiming(options, requestStartTime, requestEndTime, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

/**
 * Handle parse command output. Reuses the scrape output formatter since the
 * /v2/parse response shape matches /v2/scrape.
 */
export async function handleParseCommand(options: ParseOptions): Promise<void> {
  const result = await executeParse(options);

  if (options.query && result.success && result.data?.answer) {
    const { writeOutput } = await import('../utils/output');
    writeOutput(result.data.answer, options.output, !!options.output);
    return;
  }

  const effectiveFormats: ScrapeFormat[] =
    options.formats && options.formats.length > 0
      ? [...options.formats]
      : ['markdown'];

  handleScrapeOutput(
    result,
    effectiveFormats,
    options.output,
    options.pretty,
    options.json
  );
}
