#!/usr/bin/env node

/**
 * Firecrawl CLI
 * Entry point for the CLI application
 */

import { Command } from 'commander';
import { handleScrapeCommand } from './commands/scrape';
import { initializeConfig, updateConfig } from './utils/config';
import { configure } from './commands/config';
import { handleCreditUsageCommand } from './commands/credit-usage';
import { isUrl, normalizeUrl } from './utils/url';
import { parseScrapeOptions } from './utils/options';

// Initialize global configuration from environment variables
initializeConfig();

const program = new Command();

program
  .name('firecrawl')
  .description('CLI tool for Firecrawl web scraping')
  .version('1.0.0')
  .option(
    '-k, --api-key <key>',
    'Firecrawl API key (or set FIRECRAWL_API_KEY env var, or use "firecrawl config")'
  )
  .allowUnknownOption() // Allow unknown options when URL is passed directly
  .hook('preAction', (thisCommand, actionCommand) => {
    // Update global config if API key is provided via global option
    const globalOptions = thisCommand.opts();
    if (globalOptions.apiKey) {
      updateConfig({ apiKey: globalOptions.apiKey });
    }
  });

/**
 * Create and configure the scrape command
 */
function createScrapeCommand(): Command {
  const scrapeCmd = new Command('scrape')
    .description('Scrape a URL using Firecrawl')
    .argument('[url]', 'URL to scrape')
    .option(
      '-u, --url <url>',
      'URL to scrape (alternative to positional argument)'
    )
    .option('-H, --html', 'Output raw HTML (shortcut for --format html)')
    .option(
      '-f, --format <format>',
      'Output format: markdown, html, rawHtml, links, images, screenshot, summary, changeTracking, json, attributes, branding',
      'markdown'
    )
    .option('--only-main-content', 'Include only main content', false)
    .option(
      '--wait-for <ms>',
      'Wait time before scraping in milliseconds',
      parseInt
    )
    .option('--screenshot', 'Take a screenshot', false)
    .option('--include-tags <tags>', 'Comma-separated list of tags to include')
    .option('--exclude-tags <tags>', 'Comma-separated list of tags to exclude')
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('-o, --output <path>', 'Output file path (default: stdout)')
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

      // Handle --html shortcut flag
      const format = options.html ? 'html' : options.format;

      const scrapeOptions = parseScrapeOptions({ ...options, url, format });
      await handleScrapeCommand(scrapeOptions);
    });

  return scrapeCmd;
}

// Add scrape command to main program
program.addCommand(createScrapeCommand());

program
  .command('config')
  .description('Configure API URL and API key (interactive)')
  .action(async () => {
    await configure();
  });

program
  .command('credit-usage')
  .description('Get team credit usage information')
  .option(
    '-k, --api-key <key>',
    'Firecrawl API key (overrides global --api-key)'
  )
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

// Parse arguments
const args = process.argv.slice(2);

// Check if first argument is a URL (and not a command)
if (args.length > 0 && !args[0].startsWith('-') && isUrl(args[0])) {
  // Treat as scrape command with URL - reuse commander's parsing
  const url = normalizeUrl(args[0]);

  // Modify argv to include scrape command with URL as positional argument
  // This allows commander to parse it normally with all hooks and options
  const modifiedArgv = [
    process.argv[0],
    process.argv[1],
    'scrape',
    url,
    ...args.slice(1),
  ];

  // Parse using the main program (which includes hooks and global options)
  program.parseAsync(modifiedArgv).catch((error) => {
    console.error(
      'Error:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    process.exit(1);
  });
} else {
  // Normal command parsing
  program.parse();
}
