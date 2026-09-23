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

const providerIssues = [
  'missing_provider',
  'insufficient_coverage',
  'provider_unavailable',
  'other',
];
const capabilityIssues = [
  'new_capability_request',
  'missing_capability',
  'insufficient_functionality',
  'incorrect_result',
  'execution_error',
  'other',
];

export function parseAlexandriaFeedbackArray(
  value: string,
  capability = false
): Record<string, unknown>[] {
  let entries: unknown;
  try {
    entries = JSON.parse(value);
  } catch {
    throw new InvalidArgumentError('Feedback must be valid JSON.');
  }
  if (!Array.isArray(entries) || entries.length > 20) {
    throw new InvalidArgumentError(
      'Provide a JSON array of up to 20 feedback objects.'
    );
  }
  return entries.map((entry, index) => {
    const fail = (message: string): never => {
      throw new InvalidArgumentError(`Feedback entry ${index + 1}: ${message}`);
    };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      fail('must be an object.');
    const allowed = capability
      ? ['name', 'provider', 'issue', 'why', 'requestedFunctionality']
      : ['name', 'issue', 'why'];
    if (Object.keys(entry).some((key) => !allowed.includes(key)))
      fail('contains an unknown field.');
    const result: Record<string, unknown> = {};
    const text = (field: string, max: number) => {
      if (
        typeof entry[field] !== 'string' ||
        !entry[field].trim() ||
        entry[field].trim().length > max
      )
        fail(`${field} must contain 1–${max} characters.`);
      result[field] = entry[field].trim();
    };
    text('name', 200);
    text('why', 2000);
    if (!(capability ? capabilityIssues : providerIssues).includes(entry.issue))
      fail('unsupported issue code.');
    result.issue = entry.issue;
    if (capability) {
      text('provider', 200);
      if (
        entry.issue === 'new_capability_request' ||
        entry.requestedFunctionality !== undefined
      )
        text('requestedFunctionality', 2000);
    }
    return result;
  });
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
      (value) => parseAlexandriaFeedbackArray(value)
    )
    .option(
      '--capability-feedback <json>',
      'Array of {name, provider, issue, why, requestedFunctionality?}; issues: new_capability_request (requires requestedFunctionality), missing_capability (provider exists but lacks this capability), insufficient_functionality, incorrect_result, execution_error, other',
      (value) => parseAlexandriaFeedbackArray(value, true)
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
