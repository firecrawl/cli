import { receiptFor, printReceipt, printRetry } from '../utils/receipt';
/**
 * Search command implementation
 */

import type { FormatOption } from 'firecrawl';
import type {
  SearchOptions,
  SearchResult,
  SearchResultData,
  WebSearchResult,
  ImageSearchResult,
  NewsSearchResult,
  DeveloperSearchResult,
} from '../types/search';
import { getClient, isKeylessMode, keylessRequest } from '../utils/client';
import { writeOutput } from '../utils/output';
import { apiFailure, requireAlexandriaKey } from './alexandria';

/**
 * Execute search command
 */
export async function executeSearch(
  options: SearchOptions
): Promise<SearchResult> {
  try {
    if (options.domainTools || options.sources?.includes('alexandria'))
      requireAlexandriaKey(options.apiKey);
    // Build search options for the SDK
    const searchParams: Record<string, any> = {
      limit: options.limit,
      integration: 'cli',
    };
    if (options.domainTools !== undefined)
      searchParams.domainTools = options.domainTools;

    if (options.highlights !== undefined) {
      searchParams.highlights = options.highlights;
    }

    // Add sources if specified
    if (options.sources && options.sources.length > 0) {
      searchParams.sources = options.sources.map((source) => ({
        type: source,
      }));
    }

    // Add categories if specified
    if (options.categories && options.categories.length > 0) {
      searchParams.categories = options.categories.map((category) => ({
        type: category,
      }));
    }

    // Add time-based search parameter
    if (options.tbs) {
      searchParams.tbs = options.tbs;
    }

    // Add location parameter
    if (options.location) {
      searchParams.location = options.location;
    }

    // Add country parameter
    if (options.country) {
      searchParams.country = options.country;
    }

    // Add timeout parameter
    if (options.timeout !== undefined) {
      searchParams.timeout = options.timeout;
    }

    // Add ignoreInvalidURLs parameter
    if (options.ignoreInvalidUrls !== undefined) {
      searchParams.ignoreInvalidURLs = options.ignoreInvalidUrls;
    }

    // Add scrape options if scraping is enabled
    if (options.scrape) {
      const scrapeOptions: Record<string, any> = {};

      // Add formats
      if (options.scrapeFormats && options.scrapeFormats.length > 0) {
        scrapeOptions.formats = options.scrapeFormats.map((format) => ({
          type: format,
        }));
      } else {
        // Default to markdown if scraping is enabled but no formats specified
        scrapeOptions.formats = [{ type: 'markdown' }];
      }

      // Add onlyMainContent if specified
      if (options.onlyMainContent !== undefined) {
        scrapeOptions.onlyMainContent = options.onlyMainContent;
      }

      searchParams.scrapeOptions = scrapeOptions;
    }

    const searchBody = {
      query: options.query,
      ...searchParams,
    };

    // Call /v2/search through the SDK's HTTP layer (auth + retries) instead
    // of `app.search()` so we keep the full response envelope. The high-level
    // `search()` helper drops `id` and `creditsUsed`, which breaks the
    // `firecrawl search-feedback <id>` workflow that consumers rely on.
    let envelope: Record<string, any>;
    if (isKeylessMode(options.apiKey, options.apiUrl)) {
      // Keyless free tier: header-less request. The API identifies the CLI via
      // the `integration: 'cli'` field already in searchParams.
      envelope = (await keylessRequest('/v2/search', searchBody)) as Record<
        string,
        any
      >;
    } else {
      const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
      const httpResponse = await (app as any).http.post(
        '/v2/search',
        searchBody
      );
      envelope = (httpResponse?.data ?? {}) as Record<string, any>;
    }
    const payload = (envelope.data ?? {}) as Record<string, any>;

    const data: SearchResultData = {};
    if (payload.tools) data.tools = payload.tools;
    if (payload.web) data.web = payload.web as WebSearchResult[];
    if (payload.images) data.images = payload.images as ImageSearchResult[];
    if (payload.news) data.news = payload.news as NewsSearchResult[];
    // The `developer` category is an extra arm rather than a filter on the web
    // results, so the API returns its hits in their own group.
    if (payload.developer)
      data.developer = payload.developer as DeveloperSearchResult[];

    return {
      success: true,
      data,
      warning: envelope.warning,
      id: envelope.id,
      creditsUsed: envelope.creditsUsed,
      receipt: receiptFor(envelope, 'search'),
    };
  } catch (error) {
    const failure = apiFailure(error);
    return {
      ...failure,
      success: false,
      receipt: receiptFor(failure, 'search'),
    };
  }
}

/**
 * Shorten a matched passage for the human-readable output. A developer passage
 * runs to several KB, which floods a terminal. `--json` keeps the full text.
 */
function clipPassage(passage: string): string {
  const collapsed = passage.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 500) {
    return collapsed;
  }
  return `${collapsed.slice(0, 500)}… (truncated, use --json for the full passage)`;
}

/**
 * Format search data in human-readable way
 */
function formatSearchReadable(
  data: SearchResultData,
  options: SearchOptions
): string {
  const lines: string[] = [];

  // Format web results
  if (data.web && data.web.length > 0) {
    // Label the web group whenever another group follows it, so the reader can
    // tell the groups apart.
    const hasDeveloperResults = !!data.developer && data.developer.length > 0;
    if (
      (options.sources && options.sources.length > 1) ||
      hasDeveloperResults
    ) {
      lines.push('=== Web Results ===');
      lines.push('');
    }

    for (const result of data.web) {
      lines.push(`${result.title || 'Untitled'}`);
      lines.push(`  URL: ${result.url}`);
      if (result.description) {
        lines.push(`  ${result.description}`);
      }
      if (result.category) {
        lines.push(`  Category: ${result.category}`);
      }
      if (result.markdown) {
        lines.push('');
        lines.push('  --- Content ---');
        // Indent markdown content
        const indentedMarkdown = result.markdown
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n');
        lines.push(indentedMarkdown);
        lines.push('  --- End Content ---');
      }
      lines.push('');
    }
  }

  // Format developer results
  if (data.developer && data.developer.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('=== Developer Results ===');
    lines.push('');

    for (const result of data.developer) {
      lines.push(`${result.title || 'Untitled'}`);
      lines.push(`  URL: ${result.url}`);
      if (result.description) {
        lines.push(`  ${clipPassage(result.description)}`);
      }
      lines.push('');
    }
  }

  // Format image results
  if (data.images && data.images.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('=== Image Results ===');
    lines.push('');

    for (const result of data.images) {
      lines.push(`${result.title || 'Untitled'}`);
      lines.push(`  Image URL: ${result.imageUrl}`);
      lines.push(`  Source: ${result.url}`);
      if (result.imageWidth && result.imageHeight) {
        lines.push(`  Size: ${result.imageWidth}x${result.imageHeight}`);
      }
      lines.push('');
    }
  }

  // Format news results
  if (data.news && data.news.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('=== News Results ===');
    lines.push('');

    for (const result of data.news) {
      lines.push(`${result.title || 'Untitled'}`);
      lines.push(`  URL: ${result.url}`);
      if (result.date) {
        lines.push(`  Date: ${result.date}`);
      }
      if (result.snippet) {
        lines.push(`  ${result.snippet}`);
      }
      if (result.markdown) {
        lines.push('');
        lines.push('  --- Content ---');
        const indentedMarkdown = result.markdown
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n');
        lines.push(indentedMarkdown);
        lines.push('  --- End Content ---');
      }
      lines.push('');
    }
  }

  if (data.tools?.length) {
    lines.push('=== Alexandria Tools ===', '');
    for (const tool of data.tools) {
      const address =
        typeof tool.provider === 'string' && typeof tool.capability === 'string'
          ? `${tool.provider}/${tool.capability}`
          : undefined;
      const title = tool.label ?? tool.name ?? address ?? tool.id ?? 'Tool';
      lines.push(String(title));
      if (address) lines.push(`  Tool: ${address}`);
      if (typeof tool.description === 'string')
        lines.push(`  ${clipPassage(tool.description)}`);
      if (typeof tool.creditsCost === 'number')
        lines.push(
          `  Cost: ${tool.creditsCost} credits per ${tool.perRecord ? 'record' : 'call'}`
        );
      if (Array.isArray(tool.matchedUrls) && tool.matchedUrls.length)
        lines.push(`  Matches: ${tool.matchedUrls.join(', ')}`);
      lines.push('');
    }
    lines.push(
      'Discovery only. Inspect inputs, coverage and access in --json output.',
      'Use find-tools for tool sets or missing contracts; execute selected tools with scrape --alexandria <provider/capability> --options <json>.',
      ''
    );
  }

  return lines.join('\n');
}

/**
 * Handle search command output
 */
export async function handleSearchCommand(
  options: SearchOptions
): Promise<void> {
  const result = await executeSearch(options);

  printReceipt(result.receipt ?? {});
  printRetry(result as unknown as Record<string, unknown>);
  if (!result.success) {
    console.error('Error:', result.error);
    if (options.json || options.pretty || options.output)
      writeOutput(
        JSON.stringify(result, null, options.pretty ? 2 : undefined),
        options.output,
        !!options.output
      );
    process.exitCode = 1;
    return;
  }

  if (!result.data) {
    return;
  }

  // Check if there are any results
  const hasResults =
    (result.data.tools && result.data.tools.length > 0) ||
    (result.data.web && result.data.web.length > 0) ||
    (result.data.images && result.data.images.length > 0) ||
    (result.data.news && result.data.news.length > 0) ||
    (result.data.developer && result.data.developer.length > 0);

  let outputContent: string;

  // Use JSON format if --json or --pretty flag is set
  // --pretty implies JSON output
  if (
    options.json ||
    options.pretty ||
    options.output?.toLowerCase().endsWith('.json')
  ) {
    const jsonOutput: Record<string, any> = {
      success: true,
      data: result.data,
      receipt: result.receipt,
    };

    if (result.warning) {
      jsonOutput.warning = result.warning;
    }
    if (result.id) {
      jsonOutput.id = result.id;
    }
    if (result.creditsUsed !== undefined) {
      jsonOutput.creditsUsed = result.creditsUsed;
    }

    outputContent = options.pretty
      ? JSON.stringify(jsonOutput, null, 2)
      : JSON.stringify(jsonOutput);
  } else {
    // Default to human-readable format
    outputContent = hasResults
      ? formatSearchReadable(result.data, options)
      : 'No results found.';
  }

  writeOutput(outputContent, options.output, !!options.output);
}
