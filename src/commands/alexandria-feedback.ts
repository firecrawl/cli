import { Command, InvalidArgumentError } from 'commander';
import {
  handleEndpointFeedbackCommand,
  parseEndpointFeedbackRating,
} from './feedback';

function detail(value: string): string {
  const text = value.trim();
  if (!text || text.length > 2000)
    throw new InvalidArgumentError('Use 1–2000 characters.');
  return text;
}

function website(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || value.length > 2048)
      throw new Error();
    return value;
  } catch {
    throw new InvalidArgumentError(
      'Provide an HTTP(S) website URL, at most 2048 characters.'
    );
  }
}

function feedbackArray(value: string): Record<string, unknown>[] {
  try {
    const entries = JSON.parse(value);
    if (
      !Array.isArray(entries) ||
      entries.length > 20 ||
      entries.some(
        (entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)
      )
    )
      throw new Error();
    return entries;
  } catch {
    throw new InvalidArgumentError(
      'Provide a JSON array of up to 20 feedback objects.'
    );
  }
}

export function createAlexandriaFeedbackCommand(): Command {
  return new Command('feedback')
    .description(
      'Report Alexandria session results, provider gaps, or capability issues. No job ID, job-age limit, or credit refund.'
    )
    .requiredOption(
      '--rating <rating>',
      'good | partial | bad',
      parseEndpointFeedbackRating
    )
    .requiredOption('--url <url>', 'Requested website', website)
    .requiredOption(
      '--requested-functionality <text>',
      'What you needed from the website',
      detail
    )
    .requiredOption('--rationale <text>', 'Why you gave this rating', detail)
    .option(
      '--provider-feedback <json>',
      'Array of {name, issue, why}; issues: missing_provider, insufficient_coverage, provider_unavailable, other',
      feedbackArray
    )
    .option(
      '--capability-feedback <json>',
      'Array of {name, provider, issue, why, requestedFunctionality?}; issues: new_capability_request (requires requestedFunctionality), insufficient_functionality, incorrect_result, execution_error, other',
      feedbackArray
    )
    .option('-k, --api-key <key>', 'Firecrawl API key')
    .option('--api-url <url>', 'API base URL')
    .option('-o, --output <path>', 'Save the response to a file')
    .option('--json', 'Output compact JSON')
    .option('--pretty', 'Output formatted JSON')
    .option('--silent', 'Suppress output')
    .action(async (options) => {
      await handleEndpointFeedbackCommand({
        ...options,
        endpoint: 'alexandria',
        requestedWebsite: {
          url: options.url,
          requestedFunctionality: options.requestedFunctionality,
        },
      });
    });
}
