/**
 * Search command implementation
 */

import type { FormatOption } from '@mendable/firecrawl-js';
import type {
  SearchOptions,
  SearchResult,
  SearchResultData,
  WebSearchResult,
  ImageSearchResult,
  NewsSearchResult,
} from '../types/search';
import { getClient } from '../utils/client';
import { writeOutput } from '../utils/output';

/**
 * Execute search command
 */
export async function executeSearch(
  options: SearchOptions
): Promise<SearchResult> {
  try {
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });

    // Build search options for the SDK
    const searchParams: Record<string, any> = {
      limit: options.limit,
    };

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

    // Execute search
    const result = await app.search(options.query, searchParams);

    // Handle the response - the SDK returns the data directly or wrapped
    const data: SearchResultData = {};

    // Check if result has the expected structure
    if (result) {
      // Handle web results
      if (result.web || (result as any).data?.web) {
        data.web = (result.web ||
          (result as any).data?.web) as WebSearchResult[];
      }

      // Handle image results
      if (result.images || (result as any).data?.images) {
        data.images = (result.images ||
          (result as any).data?.images) as ImageSearchResult[];
      }

      // Handle news results
      if (result.news || (result as any).data?.news) {
        data.news = (result.news ||
          (result as any).data?.news) as NewsSearchResult[];
      }

      // If result is an array (legacy format), treat as web results
      if (Array.isArray(result)) {
        data.web = result as WebSearchResult[];
      }
    }

    return {
      success: true,
      data,
      warning: (result as any)?.warning,
      id: (result as any)?.id,
      creditsUsed: (result as any)?.creditsUsed,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
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
    if (options.sources && options.sources.length > 1) {
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

  return lines.join('\n');
}

/**
 * Handle search command output
 */
export async function handleSearchCommand(
  options: SearchOptions
): Promise<void> {
  const result = await executeSearch(options);

  if (!result.success) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  if (!result.data) {
    return;
  }

  // Check if there are any results
  const hasResults =
    (result.data.web && result.data.web.length > 0) ||
    (result.data.images && result.data.images.length > 0) ||
    (result.data.news && result.data.news.length > 0);

  if (!hasResults) {
    console.log('No results found.');
    return;
  }

  let outputContent: string;

  // Use JSON format if --json or --pretty flag is set
  // --pretty implies JSON output
  if (options.json || options.pretty) {
    const jsonOutput: Record<string, any> = {
      success: true,
      data: result.data,
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
    outputContent = formatSearchReadable(result.data, options);
  }

  writeOutput(outputContent, options.output, !!options.output);
}
