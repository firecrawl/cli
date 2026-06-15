/**
 * Scrape command implementation
 */

import type { FormatOption } from 'firecrawl';
import type {
  ScrapeOptions,
  ScrapeResult,
  ScrapeFormat,
  ScrapeLocation,
} from '../types/scrape';
import { getClient, isKeylessMode, keylessRequest } from '../utils/client';
import { handleScrapeOutput, writeOutput } from '../utils/output';
import {
  saveInteractSession,
  clearInteractSession,
} from '../utils/interact-session';
import { getOrigin } from '../utils/url';
import { executeMap } from './map';
import { getStatus } from './status';

/**
 * Output timing information if requested
 */
function outputTiming(
  options: ScrapeOptions,
  requestStartTime: number,
  requestEndTime: number,
  error?: Error | unknown
): void {
  if (!options.timing) return;

  const requestDuration = requestEndTime - requestStartTime;
  const timingInfo: {
    url: string;
    requestTime: string;
    duration: string;
    status: 'success' | 'error';
    error?: string;
  } = {
    url: options.url,
    requestTime: new Date(requestStartTime).toISOString(),
    duration: `${requestDuration}ms`,
    status: error ? 'error' : 'success',
  };

  if (error) {
    timingInfo.error = error instanceof Error ? error.message : 'Unknown error';
  }

  console.error('Timing:', JSON.stringify(timingInfo, null, 2));
}

/**
 * Execute the scrape command
 */
export async function executeScrape(
  options: ScrapeOptions
): Promise<ScrapeResult> {
  // Build scrape options
  const formats: FormatOption[] = [];

  // Add requested formats
  if (options.formats && options.formats.length > 0) {
    formats.push(...options.formats);
  }

  // Add screenshot format if requested and not already included
  if (options.fullPageScreenshot) {
    formats.push({ type: 'screenshot', fullPage: true });
  } else if (options.screenshot && !formats.includes('screenshot')) {
    formats.push('screenshot');
  }

  // Inject query format if --query was provided
  if (options.query) {
    formats.push({ type: 'query', prompt: options.query } as any);
  }

  const resolvedFormats = formats.map((format) => {
    if (format === 'json' && options.schema) {
      return { type: 'json', schema: options.schema } as FormatOption;
    }
    return format;
  });

  // If no formats specified, default to markdown
  if (formats.length === 0) {
    resolvedFormats.push('markdown');
  }

  const scrapeParams: Record<string, unknown> = {
    formats: resolvedFormats,
    integration: 'cli',
  };

  if (options.onlyMainContent !== undefined) {
    scrapeParams.onlyMainContent = options.onlyMainContent;
  }

  if (options.waitFor !== undefined) {
    scrapeParams.waitFor = options.waitFor;
  }

  if (options.includeTags && options.includeTags.length > 0) {
    scrapeParams.includeTags = options.includeTags;
  }

  if (options.excludeTags && options.excludeTags.length > 0) {
    scrapeParams.excludeTags = options.excludeTags;
  }

  if (options.maxAge !== undefined) {
    scrapeParams.maxAge = options.maxAge;
  }

  if (options.location) {
    scrapeParams.location = options.location;
  }

  if (options.profile) {
    scrapeParams.profile = options.profile;
  }

  if (options.actions) {
    scrapeParams.actions = options.actions;
  }

  if (options.proxy) {
    scrapeParams.proxy = options.proxy;
  }

  if (options.lockdown) {
    scrapeParams.lockdown = true;
  }

  if (options.redactPII) {
    scrapeParams.redactPII = true;
  }

  // Execute scrape with timing - only wrap the scrape call in try-catch
  const requestStartTime = Date.now();

  try {
    let result: any;
    if (isKeylessMode(options.apiKey, options.apiUrl)) {
      // Keyless free tier: header-less request. The API identifies the CLI via
      // the `integration: 'cli'` field already in scrapeParams.
      const json = await keylessRequest('/v2/scrape', {
        url: options.url,
        ...scrapeParams,
      });
      result = json?.data ?? json;
    } else {
      const app = getClient({
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
      });
      result = await app.scrape(options.url, scrapeParams);
    }
    const requestEndTime = Date.now();
    outputTiming(options, requestStartTime, requestEndTime);

    const scrapeId = result?.metadata?.scrapeId;
    if (scrapeId) {
      process.stderr.write(`Scrape ID: ${scrapeId}\n`);
      try {
        saveInteractSession({
          scrapeId,
          url: options.url,
          createdAt: new Date().toISOString(),
        });
      } catch {
        process.stderr.write(
          `Warning: Could not save scrape session. ` +
            `Use --scrape-id ${scrapeId} with interact.\n`
        );
      }
    }

    return {
      success: true,
      data: result,
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
 * Handle scrape command output
 */
export async function handleScrapeCommand(
  options: ScrapeOptions
): Promise<void> {
  const result = await executeScrape(options);

  // Query mode: output answer directly
  if (options.query && result.success && result.data?.answer) {
    writeOutput(result.data.answer, options.output, !!options.output);
    return;
  }

  // Determine effective formats for output handling
  const effectiveFormats: ScrapeFormat[] =
    options.formats && options.formats.length > 0
      ? [...options.formats]
      : ['markdown'];

  // Add screenshot to effective formats if it was requested separately
  if (options.screenshot && !effectiveFormats.includes('screenshot')) {
    effectiveFormats.push('screenshot');
  }

  handleScrapeOutput(
    result,
    effectiveFormats,
    options.output,
    options.pretty,
    options.json
  );
}

/**
 * Generate a filename from a URL for saving to .firecrawl/
 */
function urlToFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const pathPart = parsed.pathname
      .replace(/^\/|\/$/g, '')
      .replace(/\//g, '-');
    if (!pathPart) return `${host}.md`;
    return `${host}-${pathPart}.md`;
  } catch {
    return url.replace(/[^a-zA-Z0-9.-]/g, '_') + '.md';
  }
}

/**
 * Handle scrape for multiple URLs.
 * Each result is saved as a separate file in .firecrawl/
 */
export async function handleMultiScrapeCommand(
  urls: string[],
  options: ScrapeOptions
): Promise<void> {
  const fs = await import('fs');
  const path = await import('path');

  const dir = '.firecrawl';
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let completedCount = 0;
  let errorCount = 0;
  const total = urls.length;

  process.stderr.write(`Scraping ${total} URLs...\n`);

  const promises = urls.map(async (url) => {
    const scrapeOptions: ScrapeOptions = { ...options, url };
    const result = await executeScrape(scrapeOptions);

    const currentCount = ++completedCount;

    if (!result.success) {
      errorCount++;
      process.stderr.write(
        `[${currentCount}/${total}] Error: ${url} - ${result.error}\n`
      );
      return;
    }

    const filename = urlToFilename(url);
    const filepath = path.join(dir, filename);
    const content = result.data?.markdown || JSON.stringify(result.data);
    fs.writeFileSync(filepath, content, 'utf-8');

    process.stderr.write(`[${currentCount}/${total}] Saved: ${filepath}\n`);
  });

  await Promise.all(promises);

  clearInteractSession();
  process.stderr.write(
    `\nCompleted: ${completedCount - errorCount}/${total} succeeded`
  );
  if (errorCount > 0) {
    process.stderr.write(`, ${errorCount} failed`);
  }
  process.stderr.write(
    '\nTip: Use --scrape-id <id> with interact to target a specific scrape.\n'
  );

  if (errorCount === total) {
    process.exit(1);
  }
}

/**
 * Convert a URL path into a nested directory path with index.md.
 * e.g. https://docs.example.com/features/scrape → docs.example.com/features/scrape/index.md
 *      https://docs.example.com/ → docs.example.com/index.md
 */
function urlToNestedPath(url: string, filename: string = 'index.md'): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const pathPart = parsed.pathname.replace(/^\/|\/$/g, '');
    if (!pathPart) return `${host}/${filename}`;
    return `${host}/${pathPart}/${filename}`;
  } catch {
    return url.replace(/[^a-zA-Z0-9.-]/g, '_') + `/${filename}`;
  }
}

/**
 * Map an entire site and scrape all discovered URLs.
 * Organizes results into nested directories based on URL paths.
 */
interface AllScrapeOptions {
  limit?: number;
  yes?: boolean;
  search?: string;
  includePaths?: string[];
  excludePaths?: string[];
  allowSubdomains?: boolean;
}

/**
 * Ask a question and return the trimmed answer.
 */
async function ask(question: string): Promise<string> {
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, resolve);
  });
  rl.close();
  return answer.trim();
}

/**
 * Extract top-level path segments from URLs and return them with counts, sorted by frequency.
 */
function getTopPaths(urls: string[]): { path: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const url of urls) {
    try {
      const parts = new URL(url).pathname.replace(/^\//, '').split('/');
      if (parts[0]) {
        const segment = '/' + parts[0];
        counts.set(segment, (counts.get(segment) || 0) + 1);
      }
    } catch {
      // skip
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p, count]) => ({ path: p, count }));
}

/**
 * Run the interactive wizard when no flags are passed.
 */
async function runWizard(
  urls: string[],
  options: ScrapeOptions,
  allOptions: AllScrapeOptions
): Promise<{
  options: ScrapeOptions;
  allOptions: AllScrapeOptions;
  urls: string[];
}> {
  const { checkbox, confirm } = await import('@inquirer/prompts');

  // 1. Formats (spacebar multi-select)
  const formatChoices = await checkbox<string>({
    message: 'Which formats? (space to select, enter to confirm)',
    choices: [
      { name: 'markdown', value: 'markdown', checked: true },
      { name: 'html', value: 'html' },
      { name: 'links', value: 'links' },
      { name: 'images', value: 'images' },
      { name: 'summary', value: 'summary' },
      { name: 'screenshot', value: 'screenshot' },
      { name: 'full page screenshot', value: 'fullPageScreenshot' },
    ],
  });

  const formats: ScrapeFormat[] = [];
  for (const choice of formatChoices) {
    if (choice === 'fullPageScreenshot') {
      options = { ...options, fullPageScreenshot: true };
    } else if (choice === 'screenshot') {
      options = { ...options, screenshot: true };
    } else {
      formats.push(choice as ScrapeFormat);
    }
  }
  if (
    formats.length === 0 &&
    !options.screenshot &&
    !options.fullPageScreenshot
  ) {
    formats.push('markdown');
  }
  if (formats.length > 0) {
    options = { ...options, formats };
  }

  // 2. Main content only
  const mainContent = await confirm({
    message: 'Only main content?',
    default: false,
  });
  if (mainContent) {
    options = { ...options, onlyMainContent: true };
  }

  // 3. Filter by paths (spacebar multi-select from discovered paths)
  const topPaths = getTopPaths(urls);
  if (topPaths.length > 1) {
    const pathChoices = await checkbox<string>({
      message: 'Filter to specific paths? (space to select, enter to skip)',
      choices: topPaths.map((p) => ({
        name: `${p.path} (${p.count} pages)`,
        value: p.path,
      })),
    });

    if (pathChoices.length > 0) {
      allOptions = { ...allOptions, includePaths: pathChoices };
      urls = urls.filter((url) => {
        try {
          const pathname = new URL(url).pathname;
          return pathChoices.some((p) => pathname.startsWith(p));
        } catch {
          return false;
        }
      });
    }
  }

  return { options, allOptions, urls };
}

export async function handleAllScrapeCommand(
  siteUrl: string,
  options: ScrapeOptions,
  allOptions: AllScrapeOptions = {}
): Promise<void> {
  let { limit, yes, search, includePaths, excludePaths, allowSubdomains } =
    allOptions;
  const fs = await import('fs');
  const path = await import('path');

  // Map from origin so non-root URLs (e.g. pasted subpage) work reliably
  const mapUrl = getOrigin(siteUrl);
  process.stderr.write(`Mapping ${mapUrl}...\n`);

  const mapResult = await executeMap({
    urlOrJobId: mapUrl,
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
    search,
    includeSubdomains: allowSubdomains,
  });

  if (!mapResult.success || !mapResult.data) {
    console.error('Error mapping site:', mapResult.error);
    process.exit(1);
  }

  const totalFound = mapResult.data.links.length;
  let urls = mapResult.data.links.map((link) => link.url);

  if (urls.length === 0) {
    console.error('No URLs found on site.');
    process.exit(1);
  }

  process.stderr.write(`Found ${totalFound} pages on ${mapUrl}\n`);

  // Detect if user passed any explicit flags (non-interactive mode)
  const hasExplicitFlags =
    yes ||
    limit !== undefined ||
    includePaths !== undefined ||
    excludePaths !== undefined ||
    (options.formats &&
      options.formats.length > 0 &&
      options.formats[0] !== 'markdown') ||
    options.screenshot ||
    options.fullPageScreenshot ||
    options.onlyMainContent;

  if (!hasExplicitFlags && process.stdin.isTTY) {
    const result = await runWizard(urls, options, allOptions);
    options = result.options;
    allOptions = result.allOptions;
    urls = result.urls;
    includePaths = allOptions.includePaths;
    excludePaths = allOptions.excludePaths;
  } else {
    // Apply filters from flags
    if (includePaths && includePaths.length > 0) {
      urls = urls.filter((url) => {
        try {
          const pathname = new URL(url).pathname;
          return includePaths!.some((p) => pathname.startsWith(p));
        } catch {
          return false;
        }
      });
    }

    if (excludePaths && excludePaths.length > 0) {
      urls = urls.filter((url) => {
        try {
          const pathname = new URL(url).pathname;
          return !excludePaths!.some((p) => pathname.startsWith(p));
        } catch {
          return true;
        }
      });
    }
  }

  if (urls.length === 0) {
    console.error('No URLs matched after filtering.');
    process.exit(1);
  }

  if (limit && limit > 0) {
    urls = urls.slice(0, limit);
  }

  // Preflight: check credits and concurrency
  const status = await getStatus();
  const maxConcurrency = status.concurrency?.max || urls.length;

  if (status.credits) {
    const creditsNeeded = urls.length;
    const remaining = status.credits.remaining;

    if (creditsNeeded > remaining) {
      console.error(
        `Error: Not enough credits. Need ${creditsNeeded}, have ${remaining}.`
      );
      process.exit(1);
    }
  }

  if (!yes) {
    const creditsMsg = status.credits
      ? `, ${urls.length} credits (${status.credits.remaining.toLocaleString()} remaining)`
      : '';
    process.stderr.write(
      `\nScrape ${urls.length} pages${creditsMsg}, ${maxConcurrency} at a time.\n`
    );

    const answer = await ask('Continue? (y/N or enter a number to set limit) ');
    const asNumber = parseInt(answer, 10);

    if (!isNaN(asNumber) && asNumber > 0) {
      urls = urls.slice(0, asNumber);
      process.stderr.write(`Limiting to ${urls.length} pages.\n`);
    } else if (answer.toLowerCase() !== 'y') {
      process.stderr.write('Aborted.\n');
      process.exit(0);
    }
  }

  process.stderr.write(
    `Scraping ${urls.length}${limit ? ` of ${mapResult.data.links.length}` : ''} pages (${maxConcurrency} at a time)...\n`
  );

  const baseDir = '.firecrawl';
  let completedCount = 0;
  let errorCount = 0;
  const total = urls.length;

  let urlIndex = 0;

  const processUrl = async (url: string): Promise<void> => {
    const scrapeOptions: ScrapeOptions = { ...options, url };
    const result = await executeScrape(scrapeOptions);

    const currentCount = ++completedCount;

    if (!result.success) {
      errorCount++;
      process.stderr.write(
        `[${currentCount}/${total}] Error: ${url} - ${result.error}\n`
      );
      return;
    }

    // Save each format as its own file
    const formats = [...(options.formats || ['markdown'])];
    if (
      (options.screenshot || options.fullPageScreenshot) &&
      !formats.includes('screenshot')
    ) {
      formats.push('screenshot');
    }

    // Ensure output directory exists
    const dirPath = urlToNestedPath(url, '').replace(/\/$/, '');
    const dir = path.join(baseDir, dirPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const savedFiles: string[] = [];

    for (const fmt of formats) {
      if (fmt === 'screenshot') {
        if (result.data?.screenshot) {
          try {
            const response = await fetch(result.data.screenshot);
            if (response.ok) {
              const buffer = Buffer.from(await response.arrayBuffer());
              const filepath = path.join(dir, 'screenshot.png');
              fs.writeFileSync(filepath, buffer);
              savedFiles.push(filepath);
            }
          } catch {
            // Silently skip failed screenshot downloads
          }
        }
      } else if (fmt === 'markdown') {
        if (result.data?.markdown) {
          const filepath = path.join(dir, 'index.md');
          fs.writeFileSync(filepath, result.data.markdown, 'utf-8');
          savedFiles.push(filepath);
        }
      } else if (fmt === 'html' || fmt === 'rawHtml') {
        const html = result.data?.html || result.data?.rawHtml;
        if (html) {
          const filepath = path.join(dir, 'index.html');
          fs.writeFileSync(filepath, html, 'utf-8');
          savedFiles.push(filepath);
        }
      } else if (fmt === 'links') {
        if (Array.isArray(result.data?.links)) {
          const filepath = path.join(dir, 'links.txt');
          fs.writeFileSync(filepath, result.data.links.join('\n'), 'utf-8');
          savedFiles.push(filepath);
        }
      } else if (fmt === 'images') {
        if (Array.isArray(result.data?.images)) {
          const filepath = path.join(dir, 'images.txt');
          fs.writeFileSync(filepath, result.data.images.join('\n'), 'utf-8');
          savedFiles.push(filepath);
        }
      } else if (fmt === 'summary') {
        if (result.data?.summary) {
          const filepath = path.join(dir, 'summary.md');
          fs.writeFileSync(filepath, result.data.summary, 'utf-8');
          savedFiles.push(filepath);
        }
      } else if (fmt === 'json') {
        const filepath = path.join(dir, 'index.json');
        fs.writeFileSync(
          filepath,
          JSON.stringify(result.data, null, 2),
          'utf-8'
        );
        savedFiles.push(filepath);
      } else {
        const filepath = path.join(dir, 'index.json');
        fs.writeFileSync(
          filepath,
          JSON.stringify(result.data, null, 2),
          'utf-8'
        );
        savedFiles.push(filepath);
      }
    }

    process.stderr.write(
      `[${currentCount}/${total}] Saved: ${dir}/ (${savedFiles.length} files)\n`
    );
  };

  const runWorker = async (): Promise<void> => {
    while (urlIndex < urls.length) {
      const currentUrl = urls[urlIndex++];
      await processUrl(currentUrl);
    }
  };

  const workers = Array.from(
    { length: Math.min(maxConcurrency, urls.length) },
    () => runWorker()
  );

  await Promise.all(workers);

  process.stderr.write(
    `\nCompleted: ${completedCount - errorCount}/${total} succeeded`
  );
  if (errorCount > 0) {
    process.stderr.write(`, ${errorCount} failed`);
  }
  process.stderr.write('\n');

  if (errorCount === total) {
    process.exit(1);
  }
}
