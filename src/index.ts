#!/usr/bin/env node

/**
 * Firecrawl CLI
 * Entry point for the CLI application
 */

import { Command, Option } from 'commander';
import { readFileSync } from 'fs';
import {
  handleScrapeCommand,
  handleMultiScrapeCommand,
  handleAllScrapeCommand,
} from './commands/scrape';
import { initializeConfig, updateConfig } from './utils/config';
import { configure, viewConfig } from './commands/config';
import { handleCreditUsageCommand } from './commands/credit-usage';
import { handleCrawlCommand } from './commands/crawl';
import { handleMapCommand } from './commands/map';
import { handleParseCommand } from './commands/parse';
import { createMonitorCommand } from './commands/monitor';
import { handleSearchCommand } from './commands/search';
import {
  handleInspectPaperCommand,
  handleReadPaperCommand,
  handleRelatedPapersCommand,
  handleSearchGitHubCommand,
  handleSearchPapersCommand,
} from './commands/research';
import {
  handleSearchFeedbackCommand,
  parseValuableSourcesArg,
  parseMissingContentArg,
  type SearchFeedbackRating,
} from './commands/search-feedback';
import {
  handleEndpointFeedbackCommand,
  parseEndpointFeedbackCliOptions,
  parseEndpointFeedbackEndpoint,
} from './commands/feedback';
import { handleAgentCommand } from './commands/agent';
import {
  handleBrowserLaunch,
  handleBrowserExecute,
  handleBrowserList,
  handleBrowserClose,
  handleBrowserQuickExecute,
} from './commands/browser';
import { handleInteractExecute, handleInteractStop } from './commands/interact';
import { handleVersionCommand } from './commands/version';
import { handleLoginCommand } from './commands/login';
import { handleLogoutCommand } from './commands/logout';
import { handleLaunchCommand } from './commands/launch';
import {
  handleInitCommand,
  scaffoldTemplate,
  findTemplate,
  stepAuth,
} from './commands/init';
import { handleMakeDefaultCommand, handleSetupCommand } from './commands/setup';
import type { SetupSubcommand } from './commands/setup';
import { handleEnvPullCommand } from './commands/env';
import { handleStatusCommand } from './commands/status';
import { handleDoctorCommand } from './commands/doctor';
import { isUrl, normalizeUrl } from './utils/url';
import { parseScrapeOptions } from './utils/options';
import { isJobId } from './utils/job';
import { ensureAuthenticated, printBanner } from './utils/auth';
import { maybeShowUpdateNotice } from './utils/update-notice';
import packageJson from '../package.json';
import type { SearchSource, SearchCategory } from './types/search';
import type { ScrapeFormat } from './types/scrape';
import type { RelatedPapersOptions } from './types/research';
import type { AgentWebhookConfig } from 'firecrawl';
import { createCreateCommand } from './commands/create';

// Initialize global configuration from environment variables
initializeConfig();

// Commands that require authentication.
// NOTE: `scrape`, `search`, and `parse` are intentionally excluded — they fall
// back to the keyless free tier (rate-limited per IP) when no API key is
// configured, so they must not prompt for login. They still use a configured
// key when present.
const AUTH_REQUIRED_COMMANDS = [
  'download',
  'crawl',
  'map',
  'feedback',
  'search-feedback',
  'agent',
  'browser',
  'credit-usage',
  'monitor',
];

const commandSet = new Set<string>([]);

function collectTopLevelCommands(): void {
  commandSet.clear();
  for (const command of program.commands) {
    commandSet.add(command.name());
    for (const alias of command.aliases()) {
      commandSet.add(alias);
    }
  }
}

function parseJsonInput(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${label}: ${error instanceof Error ? error.message : 'Unable to parse JSON'}`
    );
  }
}

function parseJsonFromFile(filePath: string, label: string): unknown {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return parseJsonInput(content, `${label} file`);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Could not read ${label} file: ${filePath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${label} file: ${filePath}`);
    }
    throw error;
  }
}

function parseJsonPayload(
  inline: string | undefined,
  filePath: string | undefined,
  label: string
): unknown | undefined {
  if (inline !== undefined) {
    return parseJsonInput(inline, label);
  }

  if (filePath !== undefined) {
    return parseJsonFromFile(filePath, label);
  }

  return undefined;
}

function parseJsonObject(
  inline: string | undefined,
  filePath: string | undefined,
  label: string
): Record<string, unknown> | undefined {
  const parsed = parseJsonPayload(inline, filePath, label);
  if (parsed === undefined) {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label}: expected a JSON object`);
  }

  return parsed as Record<string, unknown>;
}

function parseJsonArray(
  inline: string | undefined,
  filePath: string | undefined,
  label: string
): Record<string, unknown>[] | undefined {
  const parsed = parseJsonPayload(inline, filePath, label);
  if (parsed === undefined) {
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid ${label}: expected a JSON array`);
  }

  return parsed as Record<string, unknown>[];
}

function parseWebhookOption(
  raw: string | undefined,
  label: string
): string | Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = parseJsonPayload(trimmed, undefined, label);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(`Invalid ${label}: expected webhook object or URL`);
    }
    return parsed as Record<string, unknown>;
  }

  return trimmed;
}

function parseCommaList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function researchLimit(options: {
  limit?: number;
  k?: number;
}): number | undefined {
  return options.k ?? options.limit;
}

function parseAgentWebhookOption(
  raw: string | undefined,
  label: string
): string | AgentWebhookConfig | undefined {
  const webhook = parseWebhookOption(raw, label);

  if (webhook === undefined || typeof webhook === 'string') {
    return webhook;
  }

  if (typeof webhook.url !== 'string' || webhook.url.trim().length === 0) {
    throw new Error(
      `Invalid ${label}: webhook object requires a non-empty "url"`
    );
  }

  return webhook as unknown as AgentWebhookConfig;
}

function getFirstPositionalArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg || arg === '--') {
      continue;
    }

    if (!arg.startsWith('-')) {
      return arg;
    }

    // Skip values for known global options and positional flags used before subcommand parsing.
    if (
      [
        '-k',
        '--api-key',
        '--api-url',
        '-u',
        '--url',
        '-f',
        '--format',
      ].includes(arg) &&
      args[i + 1] !== undefined
    ) {
      i += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      const equalsIndex = arg.indexOf('=');
      if (equalsIndex !== -1) {
        continue;
      }

      // Single-dash option with attached value is rare in commander CLI usage;
      // safest to ignore as positional-only command parser here.
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
        i += 1;
        continue;
      }
    }
  }

  return undefined;
}

function shouldShowGlobalStatus(args: string[]): boolean {
  const command = getFirstPositionalArg(args);
  if (!command) {
    return true;
  }

  return !commandSet.has(command);
}

const program = new Command();

program
  .name('firecrawl')
  .description('CLI tool for Firecrawl web scraping')
  .version(packageJson.version)
  .option(
    '-k, --api-key <key>',
    'Firecrawl API key (or set FIRECRAWL_API_KEY env var)'
  )
  .option('--api-url <url>', 'API URL (or set FIRECRAWL_API_URL env var)')
  .option('--status', 'Show version, auth status, concurrency, and credits')
  .allowUnknownOption() // Allow unknown options when URL is passed directly
  .hook('preAction', async (thisCommand, actionCommand) => {
    // Update global config if API key or URL is provided via global option
    const globalOptions = thisCommand.opts();
    const commandOptions = actionCommand.opts();
    if (globalOptions.apiKey) {
      updateConfig({ apiKey: globalOptions.apiKey });
    }
    if (globalOptions.apiUrl) {
      updateConfig({ apiUrl: globalOptions.apiUrl });
    }

    // Check if this command requires authentication
    const commandName = actionCommand.name();
    if (AUTH_REQUIRED_COMMANDS.includes(commandName)) {
      // Skip auth for custom API URLs (e.g., local development)
      // Check both global and command-level options
      const { isCustomApiUrl } = await import('./utils/config');
      const effectiveApiUrl = commandOptions.apiUrl || globalOptions.apiUrl;
      if (!isCustomApiUrl(effectiveApiUrl)) {
        // Ensure user is authenticated (prompts for login if needed)
        await ensureAuthenticated();
      }
    }
  });

/**
 * Create and configure the scrape command
 */
function createScrapeCommand(): Command {
  const scrapeCmd = new Command('scrape')
    .description(
      'Scrape one or more URLs. Multiple URLs are scraped concurrently and saved to .firecrawl/'
    )
    .argument('[urls...]', 'URL(s) to scrape')
    .option(
      '-u, --url <url>',
      'URL to scrape (alternative to positional argument)'
    )
    .option('-H, --html', 'Output raw HTML (shortcut for --format html)')
    .option(
      '-f, --format <formats>',
      'Output format(s). Multiple formats can be specified with commas (e.g., "markdown,links,images"). Available: markdown, html, rawHtml, links, images, screenshot, summary, changeTracking, json, attributes, branding. Single format outputs raw content; multiple formats output JSON.'
    )
    .option('--only-main-content', 'Include only main content', false)
    .option(
      '--wait-for <ms>',
      'Wait time before scraping in milliseconds',
      parseInt
    )
    .option('-S, --summary', 'Output summary (shortcut for --format summary)')
    .option('--screenshot', 'Take a screenshot', false)
    .option('--full-page-screenshot', 'Take a full page screenshot', false)
    .option('--include-tags <tags>', 'Comma-separated list of tags to include')
    .option('--exclude-tags <tags>', 'Comma-separated list of tags to exclude')
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as JSON format', false)
    .option('--pretty', 'Pretty print JSON output', false)
    .option(
      '--timing',
      'Show request timing and other useful information',
      false
    )
    .option(
      '--max-age <milliseconds>',
      'Maximum age of cached content in milliseconds',
      parseInt
    )
    .option(
      '--country <code>',
      'ISO country code for geo-targeted scraping (e.g., US, DE, BR)'
    )
    .option(
      '--languages <codes>',
      'Comma-separated language codes for scraping (e.g., en,es)'
    )
    .option(
      '-Q, --query <prompt>',
      'Ask a question about the page content (query format)'
    )
    .option(
      '--profile <name>',
      'Persistent browser profile name for maintaining state across scrapes'
    )
    .option(
      '--no-save-changes',
      'Load existing profile data without saving changes (default: saves changes)'
    )
    .option('--lockdown', 'Enable lockdown mode for the scrape', false)
    .option(
      '--redact-pii',
      'Redact personally identifiable information from returned content',
      false
    )
    .option('--schema <json>', 'JSON schema for structured extraction')
    .option('--schema-file <path>', 'Path to JSON schema file')
    .option('--actions <json>', 'JSON actions array to run during scrape')
    .option('--actions-file <path>', 'Path to JSON actions file')
    .option('--proxy <proxy>', 'Proxy mode for scraping (e.g., auto, basic)')

    .action(async (positionalArgs, options) => {
      // Collect URLs from positional args and --url option
      let urls: string[] = [];

      if (positionalArgs && positionalArgs.length > 0) {
        for (const arg of positionalArgs) {
          if (isUrl(arg)) {
            urls.push(normalizeUrl(arg));
          }
        }
      }

      if (options.url) {
        urls.push(normalizeUrl(options.url));
      }

      // Remove duplicates
      urls = [...new Set(urls)];

      if (urls.length === 0) {
        console.error(
          'Error: URL is required. Provide it as argument or use --url option.'
        );
        process.exit(1);
      }

      let schema: Record<string, unknown> | undefined;
      let actions: Record<string, unknown>[] | undefined;

      try {
        schema = parseJsonObject(options.schema, undefined, '--schema');
        actions = parseJsonArray(options.actions, undefined, '--actions');
      } catch (error) {
        if (error instanceof Error) {
          console.error('Error:', error.message);
          process.exit(1);
        }
      }

      if (options.schemaFile) {
        schema = parseJsonObject(
          undefined,
          options.schemaFile,
          '--schema-file'
        );
      }
      if (options.actionsFile) {
        actions = parseJsonArray(
          undefined,
          options.actionsFile,
          '--actions-file'
        );
      }

      // Determine format
      let format: string;
      const positionalFormats = (positionalArgs || []).filter(
        (arg: string) => !isUrl(arg)
      );
      if (positionalFormats.length > 0) {
        format = positionalFormats.join(',');
      } else if (options.html) {
        format = 'html';
      } else if (options.summary) {
        format = 'summary';
      } else if (options.format) {
        format = options.format;
      } else {
        format = 'markdown';
      }

      const scrapeOptions = parseScrapeOptions({
        ...options,
        url: urls[0],
        format,
      });
      const scrapeOptionsWithExtensions = {
        ...scrapeOptions,
        schema,
        actions,
        proxy: options.proxy,
      };

      if (urls.length === 1) {
        await handleScrapeCommand(scrapeOptionsWithExtensions);
      } else {
        await handleMultiScrapeCommand(urls, scrapeOptionsWithExtensions);
      }
    });

  return scrapeCmd;
}

// Add scrape command to main program
program.addCommand(createScrapeCommand());

/**
 * Create and configure the download command
 */
function createDownloadCommand(): Command {
  const downloadCmd = new Command('download')
    .description(
      'Download a site into .firecrawl/ as nested directories. Maps the site first to discover pages, then scrapes them.'
    )
    .argument('<url>', 'URL of the site to download')
    .option('--limit <number>', 'Max pages to download', parseInt)
    .option('--search <query>', 'Filter pages by search query')
    .option(
      '--include-paths <paths>',
      'Only download URLs matching these paths (comma-separated, e.g. "/docs,/blog")'
    )
    .option(
      '--exclude-paths <paths>',
      'Skip URLs matching these paths (comma-separated, e.g. "/zh,/ja,/fr,/es")'
    )
    .option('--allow-subdomains', 'Include subdomains', false)
    .option(
      '-f, --format <formats>',
      'Output format(s), comma-separated (default: markdown). Available: markdown, html, rawHtml, links, images, summary, json'
    )
    .option('-H, --html', 'Download as HTML (shortcut for --format html)')
    .option(
      '-S, --summary',
      'Download as summary (shortcut for --format summary)'
    )
    .option('--only-main-content', 'Include only main content', false)
    .option(
      '--wait-for <ms>',
      'Wait time before scraping in milliseconds',
      parseInt
    )
    .option('--screenshot', 'Take a screenshot', false)
    .option('--full-page-screenshot', 'Take a full page screenshot', false)
    .option('--include-tags <tags>', 'Comma-separated list of tags to include')
    .option('--exclude-tags <tags>', 'Comma-separated list of tags to exclude')
    .option(
      '--max-age <milliseconds>',
      'Maximum age of cached content in milliseconds',
      parseInt
    )
    .option(
      '--country <code>',
      'ISO country code for geo-targeted scraping (e.g., US, DE, BR)'
    )
    .option(
      '--languages <codes>',
      'Comma-separated language codes for scraping (e.g., en,es)'
    )
    .option('--lockdown', 'Enable lockdown mode for the scrape', false)
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .action(async (url, options) => {
      let format = 'markdown';
      if (options.html) {
        format = 'html';
      } else if (options.summary) {
        format = 'summary';
      } else if (options.format) {
        format = options.format;
      }

      const scrapeOptions = parseScrapeOptions({
        ...options,
        url: normalizeUrl(url),
        format,
      });

      await handleAllScrapeCommand(normalizeUrl(url), scrapeOptions, {
        limit: options.limit,
        yes: options.yes,
        search: options.search,
        includePaths: options.includePaths
          ?.split(',')
          .map((p: string) => p.trim()),
        excludePaths: options.excludePaths
          ?.split(',')
          .map((p: string) => p.trim()),
        allowSubdomains: options.allowSubdomains,
      });
    });

  return downloadCmd;
}

// download command is registered under 'experimental' below

/**
 * Create and configure the crawl command
 */
function createCrawlCommand(): Command {
  const crawlCmd = new Command('crawl')
    .description('Crawl a website using Firecrawl')
    .argument('[url-or-job-id]', 'URL to crawl or job ID to check status')
    .option(
      '-u, --url <url>',
      'URL to crawl (alternative to positional argument)'
    )
    .option('--status', 'Check status of existing crawl job', false)
    .option(
      '--wait',
      'Wait for crawl to complete before returning results',
      false
    )
    .option(
      '--poll-interval <seconds>',
      'Polling interval in seconds when waiting (default: 5)',
      parseFloat
    )
    .option(
      '--timeout <seconds>',
      'Timeout in seconds when waiting (default: no timeout)',
      parseFloat
    )
    .option('--progress', 'Show progress dots while waiting', false)
    .option('--limit <number>', 'Maximum number of pages to crawl', parseInt)
    .option('--max-depth <number>', 'Maximum crawl depth', parseInt)
    .option(
      '--exclude-paths <paths>',
      'Comma-separated list of paths to exclude'
    )
    .option(
      '--include-paths <paths>',
      'Comma-separated list of paths to include'
    )
    .option('--sitemap <mode>', 'Sitemap handling: skip, include', 'include')
    .option(
      '--ignore-query-parameters',
      'Ignore query parameters when crawling',
      false
    )
    .option('--crawl-entire-domain', 'Crawl entire domain', false)
    .option('--allow-external-links', 'Allow external links', false)
    .option('--allow-subdomains', 'Allow subdomains', false)
    .option('--delay <ms>', 'Delay between requests in milliseconds', parseInt)
    .option(
      '--max-concurrency <number>',
      'Maximum concurrent requests',
      parseInt
    )
    .option(
      '--scrape-options <json>',
      'JSON scrape options passed to each page crawl'
    )
    .option('--scrape-options-file <path>', 'Path to scrape options JSON file')
    .option('--webhook <url-or-json>', 'Webhook URL or webhook configuration')
    .option('--cancel', 'Cancel active crawl job by job ID', false)
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--pretty', 'Pretty print JSON output', false)
    .action(async (positionalUrlOrJobId, options) => {
      // Use positional argument if provided, otherwise use --url option
      const urlOrJobId = positionalUrlOrJobId || options.url;
      if (!urlOrJobId) {
        console.error(
          'Error: URL or job ID is required. Provide it as argument or use --url option.'
        );
        process.exit(1);
      }

      let scrapeOptions: Record<string, unknown> | undefined;
      let webhook: string | Record<string, unknown> | undefined;

      try {
        scrapeOptions = parseJsonObject(
          options.scrapeOptions,
          undefined,
          '--scrape-options'
        );
        webhook = parseWebhookOption(options.webhook, '--webhook');
      } catch (error) {
        if (error instanceof Error) {
          console.error('Error:', error.message);
          process.exit(1);
        }
      }

      if (options.scrapeOptionsFile) {
        scrapeOptions = parseJsonObject(
          undefined,
          options.scrapeOptionsFile,
          '--scrape-options-file'
        );
      }

      // Auto-detect if it's a job ID (UUID format)
      const isStatusCheck = options.status || isJobId(urlOrJobId);

      const crawlOptions = {
        urlOrJobId,
        status: isStatusCheck,
        wait: options.wait,
        pollInterval: options.pollInterval,
        timeout: options.timeout,
        progress: options.progress,
        output: options.output,
        pretty: options.pretty,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        limit: options.limit,
        maxDepth: options.maxDepth,
        excludePaths: options.excludePaths
          ? options.excludePaths.split(',').map((p: string) => p.trim())
          : undefined,
        includePaths: options.includePaths
          ? options.includePaths.split(',').map((p: string) => p.trim())
          : undefined,
        sitemap: options.sitemap,
        ignoreQueryParameters: options.ignoreQueryParameters,
        crawlEntireDomain: options.crawlEntireDomain,
        allowExternalLinks: options.allowExternalLinks,
        allowSubdomains: options.allowSubdomains,
        delay: options.delay,
        maxConcurrency: options.maxConcurrency,
        scrapeOptions,
        webhook,
        cancel: options.cancel,
      };

      await handleCrawlCommand(crawlOptions);
    });

  return crawlCmd;
}

/**
 * Create and configure the map command
 */
function createMapCommand(): Command {
  const mapCmd = new Command('map')
    .description('Map URLs on a website using Firecrawl')
    .argument('[url]', 'URL to map')
    .option(
      '-u, --url <url>',
      'URL to map (alternative to positional argument)'
    )
    .option('--wait', 'Wait for map to complete', false)
    .option('--limit <number>', 'Maximum URLs to discover', parseInt)
    .option('--search <query>', 'Search query to filter URLs')
    .option(
      '--sitemap <mode>',
      'Sitemap handling: only, include, skip',
      'include'
    )
    .option('--include-subdomains', 'Include subdomains', false)
    .option('--ignore-query-parameters', 'Ignore query parameters', false)
    .option('--timeout <seconds>', 'Timeout in seconds', parseFloat)
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as JSON format', false)
    .option('--pretty', 'Pretty print JSON output', false)
    .action(async (positionalUrl, options) => {
      // Use positional URL if provided, otherwise use --url option
      const url = positionalUrl || options.url;
      if (!url) {
        console.error(
          'Error: URL is required. Provide it as argument or use --url option.'
        );
        process.exit(1);
      }

      const mapOptions = {
        urlOrJobId: url,
        wait: options.wait,
        output: options.output,
        json: options.json,
        pretty: options.pretty,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        limit: options.limit,
        search: options.search,
        sitemap: options.sitemap,
        includeSubdomains: options.includeSubdomains,
        ignoreQueryParameters: options.ignoreQueryParameters,
        timeout: options.timeout,
      };

      await handleMapCommand(mapOptions);
    });

  return mapCmd;
}

/**
 * Create and configure the parse command
 */
function createParseCommand(): Command {
  const parseCmd = new Command('parse')
    .description(
      'Parse a local file (HTML, PDF, DOCX, DOC, ODT, RTF, XLSX, XLS) into markdown, HTML, links, JSON, and more. Uses /v2/parse.'
    )
    .argument('<file>', 'Path to the local file to parse')
    .option('-H, --html', 'Output raw HTML (shortcut for --format html)')
    .option(
      '-f, --format <formats>',
      'Output format(s). Multiple formats can be specified with commas (e.g., "markdown,links"). Available: markdown, html, rawHtml, links, images, summary, json, attributes. Single format outputs raw content; multiple formats output JSON.'
    )
    .option('--only-main-content', 'Include only main content', false)
    .option('-S, --summary', 'Output summary (shortcut for --format summary)')
    .option('--include-tags <tags>', 'Comma-separated list of tags to include')
    .option('--exclude-tags <tags>', 'Comma-separated list of tags to exclude')
    .option(
      '--timeout <ms>',
      'Timeout in milliseconds for the parse job',
      parseInt
    )
    .option(
      '-Q, --query <prompt>',
      'Ask a question about the parsed content (query format)'
    )
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as JSON format', false)
    .option('--pretty', 'Pretty print JSON output', false)
    .option(
      '--timing',
      'Show request timing and other useful information',
      false
    )
    .addHelpText(
      'after',
      `
Examples:
  $ firecrawl parse ./report.pdf
  $ firecrawl parse ./report.pdf -f markdown,links
  $ firecrawl parse ./page.html -H
  $ firecrawl parse ./contract.docx --only-main-content
  $ firecrawl parse ./report.pdf -Q "What is the total revenue?"
  $ firecrawl parse ./report.pdf --json --pretty -o report.json

Supported file types: .html, .htm, .pdf, .docx, .doc, .odt, .rtf, .xlsx, .xls
Max upload size: 50 MB
`
    )
    .action(async (file: string, options) => {
      let format: string | undefined;
      if (options.html) {
        format = 'html';
      } else if (options.summary) {
        format = 'summary';
      } else if (options.format) {
        format = options.format;
      }

      const scrapeOptions = parseScrapeOptions({
        ...options,
        url: 'file://' + file,
        format: format ?? 'markdown',
      });

      await handleParseCommand({
        file,
        formats: scrapeOptions.formats,
        onlyMainContent: scrapeOptions.onlyMainContent,
        includeTags: scrapeOptions.includeTags,
        excludeTags: scrapeOptions.excludeTags,
        timeout: options.timeout,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        pretty: options.pretty,
        json: options.json,
        timing: options.timing,
        query: options.query,
      });
    });

  return parseCmd;
}

/**
 * Create and configure the search command
 */
function createSearchCommand(): Command {
  const searchCmd = new Command('search')
    .description('Search the web using Firecrawl')
    .argument('<query>', 'Search query')
    .option(
      '--limit <number>',
      'Maximum number of results (default: 5, max: 100)',
      parseInt
    )
    .option(
      '--sources <sources>',
      'Comma-separated sources to search: web, images, news (default: web)'
    )
    .option(
      '--categories <categories>',
      'Comma-separated categories to filter: github, research, pdf'
    )
    .option(
      '--tbs <value>',
      'Time-based search: qdr:h (hour), qdr:d (day), qdr:w (week), qdr:m (month), qdr:y (year)'
    )
    .option(
      '--location <location>',
      'Location for geo-targeting (e.g., "Germany", "San Francisco,California,United States")'
    )
    .option(
      '--country <code>',
      'ISO country code for geo-targeting (default: US)'
    )
    .option(
      '--timeout <ms>',
      'Timeout in milliseconds (default: 60000)',
      parseInt
    )
    .option(
      '--ignore-invalid-urls',
      'Exclude URLs invalid for other Firecrawl endpoints',
      false
    )
    .option('--scrape', 'Enable scraping of search results', false)
    .option(
      '--scrape-formats <formats>',
      'Comma-separated scrape formats when --scrape is enabled: markdown, html, rawHtml, links, etc. (default: markdown)'
    )
    .option(
      '--only-main-content',
      'Include only main content when scraping',
      true
    )
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    // .option(
    //   '-p, --pretty',
    //   'Output as pretty JSON (default: human-readable)',
    //   false
    // )
    .option('--json', 'Output as compact JSON', false)
    .action(async (query, options) => {
      // Parse sources
      let sources: SearchSource[] | undefined;
      if (options.sources) {
        sources = options.sources
          .split(',')
          .map((s: string) => s.trim().toLowerCase()) as SearchSource[];

        // Validate sources
        const validSources = ['web', 'images', 'news'];
        for (const source of sources) {
          if (!validSources.includes(source)) {
            console.error(
              `Error: Invalid source "${source}". Valid sources: ${validSources.join(', ')}`
            );
            process.exit(1);
          }
        }
      }

      // Parse categories
      let categories: SearchCategory[] | undefined;
      if (options.categories) {
        categories = options.categories
          .split(',')
          .map((c: string) => c.trim().toLowerCase()) as SearchCategory[];

        // Validate categories
        const validCategories = ['github', 'research', 'pdf'];
        for (const category of categories) {
          if (!validCategories.includes(category)) {
            console.error(
              `Error: Invalid category "${category}". Valid categories: ${validCategories.join(', ')}`
            );
            process.exit(1);
          }
        }
      }

      // Parse scrape formats
      let scrapeFormats: ScrapeFormat[] | undefined;
      if (options.scrapeFormats) {
        scrapeFormats = options.scrapeFormats
          .split(',')
          .map((f: string) => f.trim()) as ScrapeFormat[];
      }

      const searchOptions = {
        query,
        limit: options.limit,
        sources,
        categories,
        tbs: options.tbs,
        location: options.location,
        country: options.country,
        timeout: options.timeout,
        ignoreInvalidUrls: options.ignoreInvalidUrls,
        scrape: options.scrape,
        scrapeFormats,
        onlyMainContent: options.onlyMainContent,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
        pretty: options.pretty,
      };

      await handleSearchCommand(searchOptions);
    });

  return searchCmd;
}

/**
 * Create and configure the research command group
 */
function createResearchCommand(): Command {
  const researchCmd = new Command('research')
    .description('Research arXiv papers and GitHub history using Firecrawl')
    .addHelpText(
      'after',
      `
Examples:
  $ firecrawl research search-papers "diffusion image synthesis" --limit 20
  $ firecrawl research inspect-paper arxiv:1706.03762
  $ firecrawl research related-papers arxiv:1706.03762 --intent "efficient transformers"
  $ firecrawl research read-paper arxiv:1706.03762 --question "What is the attention mechanism?"
  $ firecrawl research search-github "foundationdb queue worker shutdown" --limit 10
`
    );

  researchCmd
    .command('search-papers')
    .description(
      'Primary entry point for finding arXiv papers by topic. Semantic (HyDE) search over arXiv abstracts; returns ranked papers with arXiv id, title, and abstract. The query should be a natural-language description of what you want. Run several distinct framings of the question rather than one query. Returns up to k results (default 40).'
    )
    .argument('<query>', 'Natural-language description of the papers to find')
    .option(
      '--limit <number>',
      'Number of results to return (default: 40)',
      parseInt
    )
    .addOption(new Option('--k <number>').argParser(parseInt).hideHelp())
    .option(
      '--authors <authors>',
      'Comma-separated author substring filter(s); all must match case-insensitively'
    )
    .option(
      '--categories <categories>',
      'Comma-separated arXiv category filter(s), e.g. cs.LG,cs.IR; all must match'
    )
    .option(
      '--from <date>',
      'Inclusive lower bound on created/updated date (YYYY-MM-DD)'
    )
    .option(
      '--to <date>',
      'Inclusive upper bound on created/updated date (YYYY-MM-DD)'
    )
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as compact JSON', false)
    .option('--pretty', 'Pretty print JSON output', false)
    .action(async (query, options) => {
      await handleSearchPapersCommand({
        query,
        k: researchLimit(options),
        authors: parseCommaList(options.authors),
        categories: parseCommaList(options.categories),
        from: options.from,
        to: options.to,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
        pretty: options.pretty,
      });
    });

  researchCmd
    .command('inspect-paper')
    .description(
      'Fetch canonical metadata for one paper by primaryId or canonical paperId. Use this after search/related results when you need the full title, abstract, authors, categories, source ids, and dates rendered as markdown.'
    )
    .argument(
      '<paperId>',
      'Canonical paperId or primaryId such as arxiv:1706.03762, pmcid:PMC12530322, pmid:40953549, or doi:10.1016/j.neunet.2025.108095'
    )
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as compact JSON', false)
    .option('--pretty', 'Pretty print JSON output', false)
    .action(async (paperId, options) => {
      await handleInspectPaperCommand({
        paperId,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
        pretty: options.pretty,
      });
    });

  researchCmd
    .command('related-papers')
    .description(
      'Expand from anchor papers you have already found, via the citation graph, ranked and filtered to a natural-language intent. Pass arXiv ids of your strongest hits as seed ids. Modes: similar, citers, references. This reaches relevant papers that plain search misses. A similar call already runs a deep multi-round expansion internally.'
    )
    .argument(
      '<seedIds...>',
      'Seed paper ids, e.g. arxiv:1706.03762 2014215642691656232'
    )
    .requiredOption(
      '--intent <text>',
      'Natural-language ranking/filtering intent'
    )
    .option(
      '--mode <mode>',
      'Similarity mode: similar, citers, references (default: similar)'
    )
    .option(
      '--limit <number>',
      'Number of results to return (default: 40)',
      parseInt
    )
    .addOption(new Option('--k <number>').argParser(parseInt).hideHelp())
    .option(
      '--rerank',
      'Apply an additional rerank over the fused candidates',
      false
    )
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as compact JSON', false)
    .option('--pretty', 'Pretty print JSON output', false)
    .action(async (seedIds: string[], options) => {
      const mode = options.mode as RelatedPapersOptions['mode'] | undefined;
      if (
        mode !== undefined &&
        !['similar', 'citers', 'references'].includes(mode)
      ) {
        console.error(
          'Error: Invalid mode. Valid modes are: similar, citers, references'
        );
        process.exit(1);
      }
      await handleRelatedPapersCommand({
        seedIds,
        intent: options.intent,
        mode,
        k: researchLimit(options),
        rerank: options.rerank,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
        pretty: options.pretty,
      });
    });

  researchCmd
    .command('read-paper')
    .description(
      'Read the most relevant in-body full-text passages of one specific paper for a question. Use this to verify whether a candidate actually satisfies a constraint before you include or reject it. Returns the best-matching passages, or a notice if the paper full text is unavailable.'
    )
    .argument(
      '<paperId>',
      'Canonical paperId or primaryId such as arxiv:1706.03762, pmcid:PMC12530322, pmid:40953549, or doi:10.1016/j.neunet.2025.108095'
    )
    .requiredOption(
      '--question <text>',
      'Question to answer from the paper body'
    )
    .option(
      '--limit <number>',
      'Number of passages to return (default: 4)',
      parseInt
    )
    .addOption(new Option('--k <number>').argParser(parseInt).hideHelp())
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as compact JSON', false)
    .option('--pretty', 'Pretty print JSON output', false)
    .action(async (paperId, options) => {
      await handleReadPaperCommand({
        paperId,
        question: options.question,
        k: researchLimit(options),
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
        pretty: options.pretty,
      });
    });

  researchCmd
    .command('search-github')
    .description(
      'Search GitHub issue/PR history and repository readmes. Returns ranked matches with repo, url, a short snippet, and when available the full matched content in markdown.'
    )
    .argument('<query>', 'GitHub history/readme search query')
    .option(
      '--limit <number>',
      'Number of results to return (max: 100)',
      parseInt
    )
    .addOption(new Option('--k <number>').argParser(parseInt).hideHelp())
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as compact JSON', false)
    .option('--pretty', 'Pretty print JSON output', false)
    .action(async (query, options) => {
      await handleSearchGitHubCommand({
        query,
        k: researchLimit(options),
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
        pretty: options.pretty,
      });
    });

  return researchCmd;
}

/**
 * Create the search-feedback command. Used by agents (CLI, MCP, skills) to
 * report search-result quality after a `firecrawl search` call. The first
 * feedback per search id refunds 1 credit (search costs 2). Re-submitting
 * for the same search id is a no-op refund-wise.
 */
function createSearchFeedbackCommand(): Command {
  const cmd = new Command('search-feedback')
    .description(
      'Send feedback on a previous search result. Refunds 1 credit on first submission.'
    )
    .argument('<searchId>', 'The id returned by `firecrawl search ... --json`')
    .requiredOption('--rating <rating>', 'Overall rating: good | bad | partial')
    .option(
      '--valuable-sources <urlsOrJson>',
      'Comma-separated URLs OR JSON array of {url, reason} entries'
    )
    .option(
      '--missing-content <topicsOrJson...>',
      'Specific pieces of content missing from results. ' +
        'Accepts: JSON array of {topic, description} objects, ' +
        'comma-separated topics ("pricing tiers, api rate limits"), ' +
        'or "topic: description" form. Repeat the flag for multiple entries.'
    )
    .option(
      '--query-suggestions <text>',
      'How the query or result set could be improved'
    )
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as compact JSON', false)
    .option('--pretty', 'Pretty print JSON output', false)
    .option(
      '--silent',
      'Suppress output; useful when called in the background by another agent',
      false
    )
    .action(async (searchId: string, options: any) => {
      const rating = String(options.rating || '').toLowerCase();
      if (!['good', 'bad', 'partial'].includes(rating)) {
        console.error('Error: --rating must be one of: good, bad, partial');
        process.exit(1);
      }

      let valuableSources;
      try {
        valuableSources = parseValuableSourcesArg(options.valuableSources);
      } catch (error: any) {
        console.error('Error:', error?.message || 'Invalid --valuable-sources');
        process.exit(1);
      }

      let missingContent;
      try {
        missingContent = parseMissingContentArg(options.missingContent);
      } catch (error: any) {
        console.error('Error:', error?.message || 'Invalid --missing-content');
        process.exit(1);
      }

      await handleSearchFeedbackCommand({
        searchId,
        rating: rating as SearchFeedbackRating,
        valuableSources,
        missingContent,
        querySuggestions: options.querySuggestions,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
        pretty: options.pretty,
        silent: options.silent,
      });
    });

  return cmd;
}

/**
 * Create the generic feedback command for v2 endpoint jobs.
 */
function createFeedbackCommand(): Command {
  const cmd = new Command('feedback')
    .description('Send feedback on a Firecrawl endpoint job.')
    .argument('<endpoint>', 'Endpoint: search | scrape | parse | map')
    .argument('<jobId>', 'The job id returned by the endpoint')
    .requiredOption('--rating <rating>', 'Overall rating: good | bad | partial')
    .option(
      '--issues <codesOrJson>',
      'Comma-separated issue codes OR JSON array of issue codes'
    )
    .option(
      '--tags <codesOrJson>',
      'Comma-separated tags OR JSON array of tags'
    )
    .option('--note <text>', 'Short note describing the feedback')
    .option(
      '--valuable-sources <urlsOrJson>',
      'Comma-separated URLs OR JSON array of {url, reason} entries'
    )
    .option(
      '--missing-content <topicsOrJson...>',
      'Specific pieces of content missing from results. ' +
        'Accepts: JSON array of {topic, description} objects, ' +
        'comma-separated topics, or "topic: description" form.'
    )
    .option(
      '--query-suggestions <text>',
      'How the query or result set could be improved'
    )
    .option('--url <url>', 'Relevant URL for scrape/parse feedback')
    .option(
      '--page-numbers <numbersOrJson>',
      'Comma-separated positive page numbers OR JSON array of numbers'
    )
    .option('--metadata <json>', 'Additional small JSON object metadata')
    .option('--metadata-file <path>', 'Path to metadata JSON object')
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as compact JSON', false)
    .option('--pretty', 'Pretty print JSON output', false)
    .option(
      '--silent',
      'Suppress output; useful when called in the background by another agent',
      false
    )
    .action(async (endpointArg: string, jobId: string, options: any) => {
      let endpoint;
      try {
        endpoint = parseEndpointFeedbackEndpoint(endpointArg);
      } catch (error: any) {
        console.error('Error:', error?.message || 'Invalid endpoint');
        process.exit(1);
      }

      let parsed;
      try {
        parsed = parseEndpointFeedbackCliOptions(options);
      } catch (error: any) {
        console.error('Error:', error?.message || 'Invalid feedback options');
        process.exit(1);
      }

      await handleEndpointFeedbackCommand({
        endpoint,
        jobId,
        rating: parsed.rating,
        issues: parsed.issues,
        tags: parsed.tags,
        note: options.note,
        valuableSources: parsed.valuableSources,
        missingContent: parsed.missingContent,
        querySuggestions: options.querySuggestions,
        url: options.url,
        pageNumbers: parsed.pageNumbers,
        metadata: parsed.metadata,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
        pretty: options.pretty,
        silent: options.silent,
      });
    });

  return cmd;
}

/**
 * Create and configure the agent command
 */
function createAgentCommand(): Command {
  const agentCmd = new Command('agent')
    .description('Run an AI agent to extract data from the web')
    .argument(
      '<prompt-or-job-id>',
      'Natural language prompt describing data to extract, or job ID to check status'
    )
    .option('--urls <urls>', 'Comma-separated URLs to focus extraction on')
    .option(
      '--model <model>',
      'Model to use: spark-1-mini (default, cheaper) or spark-1-pro (higher accuracy)'
    )
    .option(
      '--schema <json>',
      'JSON schema for structured output (inline JSON string)'
    )
    .option(
      '--schema-file <path>',
      'Path to JSON schema file for structured output'
    )
    .option(
      '--max-credits <number>',
      'Maximum credits to spend (job fails if exceeded)',
      parseInt
    )
    .option('--webhook <url-or-json>', 'Webhook URL or webhook configuration')
    .option('--status', 'Check status of existing agent job', false)
    .option('--cancel', 'Cancel active agent job by job ID', false)
    .option(
      '--wait',
      'Wait for agent to complete before returning results',
      false
    )
    .option(
      '--poll-interval <seconds>',
      'Polling interval in seconds when waiting (default: 5)',
      parseFloat
    )
    .option(
      '--timeout <seconds>',
      'Timeout in seconds when waiting (default: no timeout)',
      parseFloat
    )
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as JSON format', false)
    .option('--pretty', 'Pretty print JSON output', false)
    .action(async (promptOrJobId, options) => {
      // Auto-detect if it's a job ID (UUID format)
      const isStatusCheck = options.status || isJobId(promptOrJobId);
      const isCancel = options.cancel;

      if ((isStatusCheck || isCancel) && !isJobId(promptOrJobId)) {
        console.error(
          'Error: --status and --cancel require a job ID, not a prompt.'
        );
        process.exit(1);
      }

      // Parse URLs
      let urls: string[] | undefined;
      if (options.urls) {
        urls = options.urls
          .split(',')
          .map((u: string) => u.trim())
          .filter((u: string) => u.length > 0);
      }

      // Parse inline schema
      let schema: Record<string, unknown> | undefined;
      if (options.schema) {
        try {
          schema = JSON.parse(options.schema) as Record<string, unknown>;
        } catch {
          console.error('Error: Invalid JSON in --schema option');
          process.exit(1);
        }
      }
      if (options.schemaFile) {
        schema = parseJsonObject(
          undefined,
          options.schemaFile,
          '--schema-file'
        );
      }

      let webhook: string | AgentWebhookConfig | undefined;
      try {
        webhook = parseAgentWebhookOption(options.webhook, '--webhook');
      } catch (error) {
        if (error instanceof Error) {
          console.error('Error:', error.message);
          process.exit(1);
        }
      }

      // Validate model
      const validModels = ['spark-1-pro', 'spark-1-mini'];
      if (options.model && !validModels.includes(options.model)) {
        console.error(
          `Error: Invalid model "${options.model}". Valid models: ${validModels.join(', ')}`
        );
        process.exit(1);
      }

      const agentOptions = {
        prompt: promptOrJobId,
        urls,
        schema,
        model: options.model,
        maxCredits: options.maxCredits,
        status: isStatusCheck,
        cancel: isCancel,
        wait: options.wait,
        pollInterval: options.pollInterval,
        timeout: options.timeout,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
        pretty: options.pretty,
        webhook,
      };

      await handleAgentCommand(agentOptions);
    });

  return agentCmd;
}

/**
 * Create and configure the browser command (deprecated — prefer scrape + interact)
 */
function createBrowserCommand(): Command {
  const browserCmd = new Command('browser')
    .description(
      '[Deprecated: prefer scrape + interact] Launch cloud browser sessions and execute code remotely via Playwright'
    )
    .argument('[code]', 'Shorthand: auto-launch session + execute command')
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option(
      '--profile <name>',
      'Name for a profile (survives close, reconnect by name later)'
    )
    .option(
      '--no-save-changes',
      'Load existing profile data without saving changes (default: saves changes)'
    )
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as JSON format', false)
    .action(async (code, options) => {
      if (code) {
        await handleBrowserQuickExecute({
          code,
          profile: options.profile,
          saveChanges: options.saveChanges,
          apiKey: options.apiKey,
          apiUrl: options.apiUrl,
          output: options.output,
          json: options.json,
        });
      }
    })
    .addHelpText(
      'after',
      `
Shorthand (auto-launches session if needed):
  $ firecrawl browser "open https://example.com"
  $ firecrawl browser "snapshot"
  $ firecrawl browser "click @e5"
  $ firecrawl browser "scrape"

Explicit subcommands:
  $ firecrawl browser launch-session
  $ firecrawl browser execute "open https://example.com"
  $ firecrawl browser list active
  $ firecrawl browser close

  By default, commands are sent to agent-browser (pre-installed in every sandbox).
  Use --python or --node to run Playwright code instead.
  $ firecrawl browser execute --python 'print(await page.title())'
  $ firecrawl browser execute --node 'await page.title()'

  See all agent-browser commands:
  $ firecrawl browser execute "--help"
`
    );

  browserCmd
    .command('launch-session')
    .description(
      'Launch a new cloud browser session (without executing a command)'
    )
    .option(
      '--ttl <seconds>',
      'Total session TTL in seconds (default: 300)',
      parseInt
    )
    .option('--ttl-inactivity <seconds>', 'Inactivity TTL in seconds', parseInt)
    .option(
      '--profile <name>',
      'Name for a profile (survives close, reconnect by name later)'
    )
    .option(
      '--no-save-changes',
      'Load existing profile data without saving changes (default: saves changes)'
    )
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as JSON format', false)
    .addHelpText(
      'after',
      `
Output:
  Prints the Session ID and CDP URL. The session is auto-saved so
  subsequent execute/close commands target it automatically.

  Tip: Use the shorthand to launch + execute in one step:
    $ firecrawl browser "open https://example.com"

Examples:
  $ firecrawl browser launch-session
  $ firecrawl browser launch-session --ttl 600
  $ firecrawl browser launch-session --ttl 300 --ttl-inactivity 60
  $ firecrawl browser launch-session --profile my-session
  $ firecrawl browser launch-session --profile my-session --no-save-changes
  $ firecrawl browser launch-session -o session.json --json
`
    )
    .action(async (options) => {
      await handleBrowserLaunch({
        ttl: options.ttl,
        ttlInactivity: options.ttlInactivity,
        profile: options.profile,
        saveChanges: options.saveChanges,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
      });
    });

  browserCmd
    .command('execute')
    .description(
      'Execute agent-browser commands (default), or Playwright Python/JS in a session'
    )
    .argument(
      '<code>',
      'agent-browser command (default) or Playwright code (with --python/--node)'
    )
    .option('--python', 'Execute as Playwright Python code', false)
    .option('--node', 'Execute as Playwright JavaScript code', false)
    .option(
      '--bash',
      'Execute bash in the sandbox (agent-browser pre-installed, CDP_URL auto-injected)',
      false
    )
    .option(
      '--session <id>',
      'Session ID (default: active session from last launch)'
    )
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as JSON format', false)
    .addHelpText(
      'after',
      `
How it works:
  By default, commands are sent to agent-browser (pre-installed in every sandbox).
  You don't need to type "agent-browser" — it's added automatically.

agent-browser examples (default):
  $ firecrawl browser execute "open https://example.com"
  $ firecrawl browser execute "snapshot"
  $ firecrawl browser execute "click @e5"
  $ firecrawl browser execute "scrape"

  You can still pass the full command if you prefer:
  $ firecrawl browser execute "agent-browser snapshot"

  Use --bash for arbitrary bash commands (not just agent-browser):
  $ firecrawl browser execute --bash 'ls /tmp'

Python examples (use --python):
  $ firecrawl browser execute --python 'print(await page.title())'
  $ firecrawl browser execute --python '
    await page.goto("https://news.ycombinator.com")
    title = await page.title()
    items = await page.query_selector_all(".titleline > a")
    for item in items[:5]:
        print(await item.inner_text())
  '

JavaScript examples (use --node):
  $ firecrawl browser execute --node 'await page.goto("https://example.com"); await page.title()'

Target a specific session:
  $ firecrawl browser execute --session <id> "snapshot"

Note: --python, --node, and --bash are mutually exclusive.
`
    )
    .action(async (code, options) => {
      const flagCount = [options.python, options.node, options.bash].filter(
        Boolean
      ).length;
      if (flagCount > 1) {
        console.error(
          'Error: Only one of --python, --node, or --bash can be specified'
        );
        process.exit(1);
      }
      const language = options.python
        ? 'python'
        : options.node
          ? 'node'
          : 'bash';

      // In default/bash mode, auto-prefix "agent-browser" if not already present
      let finalCode = code;
      if (
        language === 'bash' &&
        !options.bash &&
        !finalCode.startsWith('agent-browser')
      ) {
        finalCode = `agent-browser ${finalCode}`;
      }

      await handleBrowserExecute({
        code: finalCode,
        language,
        session: options.session,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
      });
    });

  browserCmd
    .command('list [status]')
    .description(
      'List browser sessions (optionally filter by: active, destroyed)'
    )
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as JSON format', false)
    .addHelpText(
      'after',
      `
Examples:
  $ firecrawl browser list
  $ firecrawl browser list active
  $ firecrawl browser list destroyed
  $ firecrawl browser list --json
`
    )
    .action(async (status, options) => {
      if (status && !['active', 'destroyed'].includes(status)) {
        console.error(
          `Error: Invalid status "${status}". Use "active" or "destroyed".`
        );
        process.exit(1);
      }
      await handleBrowserList({
        status,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
      });
    });

  browserCmd
    .command('close')
    .description('Close a browser session')
    .option(
      '--session <id>',
      'Session ID (default: active session from last launch)'
    )
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as JSON format', false)
    .addHelpText(
      'after',
      `
Examples:
  $ firecrawl browser close
  $ firecrawl browser close --session <id>
`
    )
    .action(async (options) => {
      await handleBrowserClose({
        session: options.session,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
      });
    });

  return browserCmd;
}

/**
 * Create and configure the interact command
 */
function createInteractCommand(): Command {
  const interactCmd = new Command('interact')
    .description(
      'Interact with a scraped page in a live browser session. Run AI prompts or execute code against any previous scrape.'
    )
    .argument('[args...]', 'Prompt text, or scrape-id followed by prompt text')
    .option('-c, --code <code>', 'Code to execute in the browser sandbox')
    .option(
      '-p, --prompt <text>',
      'AI prompt (alternative to positional argument)'
    )
    .option('-s, --scrape-id <id>', 'Scrape job ID (default: last scrape)')
    .option('--node', 'Execute code as Node.js/Playwright (default)', false)
    .option('--python', 'Execute code as Python/Playwright', false)
    .option('--bash', 'Execute code as Bash', false)
    .option(
      '--timeout <seconds>',
      'Timeout in seconds (1-300, default: 30)',
      parseInt
    )
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as JSON format', false)
    .addHelpText(
      'after',
      `
  The scrape ID is saved automatically after every scrape, so you
  don't need to pass it explicitly. Just scrape and interact:

    $ firecrawl scrape https://example.com
    $ firecrawl interact "Click the pricing tab"
    $ firecrawl interact "What is the price of the Pro plan?"
    $ firecrawl interact stop

  You can also pass a scrape ID explicitly:

    $ firecrawl interact <scrape-id> "Click the pricing tab"
    $ firecrawl interact -s <scrape-id> "Click the pricing tab"

  Code execution:

    $ firecrawl interact -c "await page.title()"
    $ firecrawl interact -c "print(await page.title())" --python
    $ firecrawl interact -c "snapshot" --bash
`
    )
    .action(async (positionalArgs: string[], options) => {
      // Disambiguate positional args: if the first arg looks like a UUID,
      // treat it as scrape-id; otherwise treat everything as prompt text.
      let scrapeId: string | undefined = options.scrapeId;
      let prompt: string | undefined = options.prompt;

      if (positionalArgs.length > 0) {
        if (!scrapeId && isJobId(positionalArgs[0])) {
          scrapeId = positionalArgs[0];
          if (positionalArgs.length > 1) {
            prompt = prompt || positionalArgs.slice(1).join(' ');
          }
        } else {
          prompt = prompt || positionalArgs.join(' ');
        }
      }

      if (!options.code && !prompt) {
        console.error(
          'Error: Provide an AI prompt or use --code to execute code.\n' +
            'Example: firecrawl interact "Click the pricing tab"'
        );
        process.exit(1);
      }

      if (options.code && prompt) {
        console.error('Error: Provide either a prompt or --code, not both.');
        process.exit(1);
      }

      const flagCount = [options.python, options.node, options.bash].filter(
        Boolean
      ).length;
      if (flagCount > 1) {
        console.error(
          'Error: Only one of --python, --node, or --bash can be specified'
        );
        process.exit(1);
      }
      const language = options.python
        ? 'python'
        : options.bash
          ? 'bash'
          : 'node';

      await handleInteractExecute({
        scrapeId,
        prompt: options.code ? undefined : prompt,
        code: options.code,
        language,
        timeout: options.timeout,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
      });
    });

  interactCmd
    .command('stop')
    .description('Stop the interactive browser session for a scrape')
    .argument('[scrape-id]', 'Scrape job ID (default: last scrape)')
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--json', 'Output as JSON format', false)
    .addHelpText(
      'after',
      `
Examples:
  $ firecrawl interact stop
  $ firecrawl interact stop <scrape-id>
`
    )
    .action(async (scrapeId, options) => {
      await handleInteractStop({
        scrapeId,
        apiKey: options.apiKey,
        apiUrl: options.apiUrl,
        output: options.output,
        json: options.json,
      });
    });

  return interactCmd;
}

// Add core commands to main program
program.addCommand(createCrawlCommand());
program.addCommand(createMapCommand());
program.addCommand(createParseCommand());
program.addCommand(createMonitorCommand());
program.addCommand(createSearchCommand());
program.addCommand(createResearchCommand());
program.addCommand(createFeedbackCommand());
program.addCommand(createSearchFeedbackCommand());
program.addCommand(createAgentCommand());
program.addCommand(createInteractCommand());

// Hidden: deprecated browser command (still works, just not in --help)
program.addCommand(createBrowserCommand(), { hidden: true });

// Hidden: `firecrawl create <kind>` — scaffolds Firecrawl starter projects.
// Undocumented until `firecrawl-agent-cli` is published to npm; flip to
// visible by removing `{ hidden: true }`.
program.addCommand(createCreateCommand(), { hidden: true });

// Experimental: download command
const experimental = new Command('experimental')
  .description('Experimental commands (download)')
  .alias('x')
  .addHelpText(
    'after',
    `
Shorthand: "firecrawl x" is an alias for "firecrawl experimental".
`
  );
experimental.addCommand(createDownloadCommand());
program.addCommand(experimental);

program
  .command('config')
  .description('Configure Firecrawl (login if not authenticated)')
  .option(
    '-k, --api-key <key>',
    'Provide API key directly (skips interactive flow)'
  )
  .option('--api-url <url>', 'API URL (default: https://api.firecrawl.dev)')
  .option(
    '--web-url <url>',
    'Web URL for browser login (default: https://firecrawl.dev)'
  )
  .option(
    '-m, --method <method>',
    'Login method: "browser" or "manual" (default: interactive prompt)'
  )
  .option('-b, --browser', 'Login via browser (shortcut for --method browser)')
  .action(async (options) => {
    await configure({
      apiKey: options.apiKey,
      apiUrl: options.apiUrl,
      webUrl: options.webUrl,
      method: options.browser ? 'browser' : options.method,
    });
  });

program
  .command('view-config')
  .description('View current configuration and authentication status')
  .action(async () => {
    await viewConfig();
  });

program
  .command('login')
  .description('Login to Firecrawl (alias for config)')
  .option(
    '-k, --api-key <key>',
    'Provide API key directly (skips interactive flow)'
  )
  .option('--api-url <url>', 'API URL (default: https://api.firecrawl.dev)')
  .option(
    '--web-url <url>',
    'Web URL for browser login (default: https://firecrawl.dev)'
  )
  .option(
    '-m, --method <method>',
    'Login method: "browser" or "manual" (default: interactive prompt)'
  )
  .option('-b, --browser', 'Login via browser (shortcut for --method browser)')
  .action(async (options) => {
    const globalOptions = program.opts();
    await handleLoginCommand({
      apiKey: options.apiKey ?? globalOptions.apiKey,
      apiUrl: options.apiUrl ?? globalOptions.apiUrl,
      webUrl: options.webUrl,
      method: options.browser ? 'browser' : options.method,
    });
  });

program
  .command('logout')
  .description('Logout and clear stored credentials')
  .action(async () => {
    await handleLogoutCommand();
  });

program
  .command('init')
  .description(
    'Set up Firecrawl: install CLI, authenticate, add integrations, and scaffold a template'
  )
  .argument(
    '[template]',
    'Template to scaffold (e.g. browser-nextjs, scrape-express)'
  )
  .option(
    '--all',
    'Explicitly install skills to all detected agents (default unless --agent is used)'
  )
  .option(
    '-y, --yes',
    'Run init non-interactively; skills still install globally across all detected agents unless --agent is used'
  )
  .option('-g, --global', 'Install skills globally (user-level, default)')
  .option('-a, --agent <agent>', 'Install skills to a specific agent')
  .option(
    '-k, --api-key <key>',
    'Authenticate with this API key (skips interactive login)'
  )
  .option(
    '-b, --browser',
    'Authenticate via browser without prompting (recommended for agents)'
  )
  .option('--skip-install', 'Skip global CLI installation')
  .option('--skip-auth', 'Skip authentication')
  .option('--skip-skills', 'Skip skills installation')
  .action(async (template, options) => {
    const globalOptions = program.opts();
    await handleInitCommand({
      template,
      global: options.global,
      agent: options.agent,
      all: options.all,
      yes: options.yes,
      apiKey: options.apiKey ?? globalOptions.apiKey,
      browser: options.browser,
      skipInstall: options.skipInstall,
      skipAuth: options.skipAuth,
      skipSkills: options.skipSkills,
    });
  });

program
  .command('setup')
  .description(
    'Set up individual firecrawl integrations (skills, workflows, mcp, defaults)'
  )
  .argument(
    '[subcommand]',
    'What to set up: "skills", "workflows", "mcp", or "defaults"; omit for an interactive installer'
  )
  .option('-g, --global', 'Install globally (user-level)')
  .option(
    '-a, --agent <agent>',
    'Limit to a specific agent; for "mcp", use "all" to update every launch integration'
  )
  .option(
    '-y, --yes',
    'Skip prompts; for bare setup, install the default skills + MCP bundle'
  )
  .option(
    '--undo',
    'Undo setup defaults by re-enabling native web tools where supported'
  )
  .action(async (subcommand: SetupSubcommand, options) => {
    await handleSetupCommand(subcommand, options);
  });

program
  .command('make')
  .description('Make Firecrawl the default provider for supported workflows')
  .argument('<target>', 'What to make default: "default"')
  .option(
    '--undo',
    'Undo default provider config by re-enabling native web tools where supported'
  )
  .action(async (target, options) => {
    if (target !== 'default') {
      console.error(`Unknown make target: ${target}`);
      console.log('\nAvailable targets:');
      console.log(
        '  default    Make Firecrawl the default web provider for supported AI agents'
      );
      process.exit(1);
    }

    await handleMakeDefaultCommand(options);
  });

program
  .command('launch')
  .alias('launcher')
  .description('Configure Firecrawl MCP for an AI agent, then launch it')
  .argument(
    '[agent]',
    'Agent to launch: claude, code/vscode, codex, codex-app, hermes, openclaw, or opencode; omit for an interactive picker'
  )
  .argument('[args...]', 'Extra arguments passed to the launched agent')
  .option('--install', 'Install Firecrawl MCP without launching')
  .option('--setup', 'Alias for --install')
  .option('--config', 'Alias for --install')
  .option('--skip-mcp', 'Launch without installing or updating Firecrawl MCP')
  .option('--skip-skills', 'Launch without installing Firecrawl skills')
  .option(
    '-g, --global',
    'Install Firecrawl MCP globally for the selected agent',
    true
  )
  .option('-y, --yes', 'Skip setup picker and installer confirmation prompts')
  .allowUnknownOption()
  .action(async (agent: string, args: string[], options) => {
    await handleLaunchCommand(agent, options, args);
  });

program
  .command('env')
  .description('Pull FIRECRAWL_API_KEY into a local .env file')
  .option('-f, --file <path>', 'Target env file (default: .env)')
  .option('--overwrite', 'Overwrite existing FIRECRAWL_API_KEY if present')
  .action(async (options) => {
    await handleEnvPullCommand({
      file: options.file,
      overwrite: options.overwrite,
    });
  });

program
  .command('credit-usage')
  .description('Get team credit usage information')
  .option(
    '-k, --api-key <key>',
    'Firecrawl API key (overrides global --api-key)'
  )
  .option('--api-url <url>', 'API URL (overrides global --api-url)')
  .option('-o, --output <path>', 'Output file path (default: stdout)')
  .option('--json', 'Output as JSON format', false)
  .option(
    '--pretty',
    'Pretty print JSON output (only applies with --json)',
    false
  )
  .action(async (options) => {
    await handleCreditUsageCommand(options);
  });

program
  .command('doctor')
  .description(
    'Run environment diagnostics, or diagnose a specific run by job ID'
  )
  .argument('[job-id]', 'Job ID to diagnose via /v2/support/ask')
  .option('--run <id>', 'Job ID to diagnose (alternative to positional arg)')
  .option(
    '--query <text>',
    'Custom support query (default: "why did this run fail?")'
  )
  .option(
    '-k, --api-key <key>',
    'Firecrawl API key (overrides global --api-key)'
  )
  .option('--api-url <url>', 'API URL (overrides global --api-url)')
  .option('--json', 'Output as JSON', false)
  .addHelpText(
    'after',
    `
Examples:
  $ firecrawl doctor                  # environment health check
  $ firecrawl doctor <job-id>         # diagnose a failed run
  $ firecrawl doctor --run <job-id>   # same, via flag
  $ firecrawl doctor --json           # machine-readable output

Exits 1 if any check fails.
`
  )
  .action(async (positionalJobId: string | undefined, options) => {
    const globalOptions = program.opts();
    let jobId = options.run || positionalJobId;
    if (jobId && !isJobId(jobId)) {
      console.error(
        `Error: "${jobId}" is not a valid job ID. Run \`firecrawl doctor\` (no argument) for an environment health check.`
      );
      process.exit(1);
    }

    await handleDoctorCommand({
      jobId,
      query: options.query,
      apiKey: options.apiKey ?? globalOptions.apiKey,
      apiUrl: options.apiUrl ?? globalOptions.apiUrl,
      json: options.json,
    });
  });

program
  .command('version')
  .description('Display version information')
  .option('--auth-status', 'Also show authentication status', false)
  .action((options) => {
    handleVersionCommand({ authStatus: options.authStatus });
  });

collectTopLevelCommands();

// Handle the main entry point
async function main() {
  // Parse user arguments explicitly instead of letting Commander infer whether
  // argv came from node, eval, electron, or another wrapper.
  const args = process.argv.slice(2);

  // Handle --version with --auth-status before Commander processes it
  // Commander's built-in --version handler doesn't support additional flags
  const hasVersion = args.includes('--version') || args.includes('-V');
  const hasAuthStatus = args.includes('--auth-status');

  if (hasVersion && hasAuthStatus) {
    const { isAuthenticated } = await import('./utils/auth');
    console.log(`version: ${packageJson.version}`);
    console.log(`authenticated: ${isAuthenticated()}`);
    return;
  }

  // Handle --status flag
  if (args.includes('--status') && shouldShowGlobalStatus(args)) {
    await handleStatusCommand();
    return;
  }

  await maybeShowUpdateNotice();

  // If no arguments or just help flags, check auth and show appropriate message
  if (args.length === 0) {
    const { isAuthenticated } = await import('./utils/auth');

    if (!isAuthenticated()) {
      // Not authenticated - run the onboarding auth step, which offers logging in
      // OR continuing on the keyless free tier (no API key required).
      printBanner();
      await stepAuth({});

      console.log("You're all set! Try scraping a URL:\n");
      console.log('  firecrawl https://example.com\n');
      console.log('For more commands, run: firecrawl --help\n');
      return;
    }

    // Authenticated - show banner and help
    printBanner();
    program.outputHelp();
    return;
  }

  // Shorthand: `firecrawl -y` → `firecrawl init --all --browser`
  if (
    args.length >= 1 &&
    (args[0] === '-y' || args[0] === '--yes') &&
    args.length <= 1
  ) {
    await handleInitCommand({ yes: true, all: true, browser: true });
    return;
  }

  // Check if first argument is a template name
  if (!args[0].startsWith('-') && findTemplate(args[0])) {
    await scaffoldTemplate(args[0]);
    return;
  }

  // Check if first argument is a URL (and not a command)
  if (!args[0].startsWith('-') && isUrl(args[0])) {
    // Treat as scrape command with URL - reuse commander's parsing
    const url = normalizeUrl(args[0]);

    // Collect any positional format arguments (non-flag arguments after the URL)
    const remainingArgs = args.slice(1);
    const positionalFormats: string[] = [];
    const otherArgs: string[] = [];

    for (const arg of remainingArgs) {
      // If it starts with a dash, it's a flag (and everything after goes to otherArgs)
      if (arg.startsWith('-')) {
        otherArgs.push(arg);
      } else if (otherArgs.length === 0) {
        // Only treat as positional format if we haven't hit a flag yet
        positionalFormats.push(arg);
      } else {
        // This is an argument to a flag
        otherArgs.push(arg);
      }
    }

    // Modify argv to include scrape command with URL and formats as positional arguments
    // This allows commander to parse it normally with all hooks and options
    const modifiedArgs = ['scrape', url, ...positionalFormats, ...otherArgs];

    // Parse using the main program (which includes hooks and global options)
    await program.parseAsync(modifiedArgs, { from: 'user' });
  } else {
    // Normal command parsing
    await program.parseAsync(args, { from: 'user' });
  }
}

main().catch((error) => {
  console.error(
    'Error:',
    error instanceof Error ? error.message : 'Unknown error'
  );
  process.exit(1);
});
