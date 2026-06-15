import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getConfig, isCustomApiUrl, validateConfig } from '../utils/config';
import { getClient } from '../utils/client';
import {
  parseMissingContentArg,
  parseValuableSourcesArg,
  type MissingContentInput,
  type SearchFeedbackRating,
  type ValuableSourceInput,
} from './search-feedback';

export type EndpointFeedbackEndpoint = 'search' | 'scrape' | 'parse' | 'map';

export interface EndpointFeedbackOptions {
  endpoint: EndpointFeedbackEndpoint;
  jobId: string;
  rating: SearchFeedbackRating;
  issues?: string[];
  tags?: string[];
  note?: string;
  valuableSources?: ValuableSourceInput[];
  missingContent?: MissingContentInput[];
  querySuggestions?: string;
  url?: string;
  pageNumbers?: number[];
  metadata?: Record<string, unknown>;
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
  pretty?: boolean;
  silent?: boolean;
}

export type EndpointFeedbackErrorCode =
  | 'JOB_NOT_FOUND'
  | 'SEARCH_NOT_FOUND'
  | 'FEEDBACK_WINDOW_EXPIRED'
  | 'SEARCH_FAILED'
  | 'PREVIEW_TEAM_NOT_ALLOWED'
  | 'TEAM_OPTED_OUT'
  | 'INVALID_BODY'
  | 'DB_DISABLED'
  | 'INTERNAL';

export interface EndpointFeedbackResult {
  success: boolean;
  feedbackId?: string;
  creditsRefunded?: number;
  creditsRefundedToday?: number;
  dailyRefundCap?: number;
  dailyCapReached?: boolean;
  alreadySubmitted?: boolean;
  warning?: string;
  error?: string;
  errorCode?: EndpointFeedbackErrorCode;
  status?: number;
  disabled?: boolean;
  disabledSource?: 'env' | 'team';
}

export const ENDPOINT_FEEDBACK_OPT_OUT_ENV_VARS = [
  'FIRECRAWL_NO_ENDPOINT_FEEDBACK',
  'FIRECRAWL_DISABLE_ENDPOINT_FEEDBACK',
] as const;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const DEFAULT_API_URL = 'https://api.firecrawl.dev';

export const ENDPOINT_FEEDBACK_ENDPOINTS: EndpointFeedbackEndpoint[] = [
  'search',
  'scrape',
  'parse',
  'map',
];

function normalizeList(entries: string[] | undefined): string[] | undefined {
  const cleaned = entries
    ?.map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return cleaned && cleaned.length > 0 ? cleaned : undefined;
}

export function parseFeedbackListArg(
  raw: string | undefined,
  label: string
): string[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        throw new Error(`${label} must be a JSON array.`);
      }
      return normalizeList(
        parsed
          .filter((entry) => typeof entry === 'string')
          .map((entry) => entry as string)
      );
    } catch (error: any) {
      throw new Error(
        `${label} must be a comma-separated list or valid JSON array.`
      );
    }
  }

  return normalizeList(trimmed.split(','));
}

export function parsePageNumbersArg(
  raw: string | undefined
): number[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  let values: unknown[];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        throw new Error('--page-numbers must be a JSON array.');
      }
      values = parsed;
    } catch {
      throw new Error(
        '--page-numbers must be a comma-separated list or valid JSON array.'
      );
    }
  } else {
    values = trimmed.split(',').map((entry) => entry.trim());
  }

  const numbers = values
    .map((value) =>
      typeof value === 'number' ? value : Number.parseInt(String(value), 10)
    )
    .filter((value) => Number.isInteger(value) && value > 0);

  return numbers.length > 0 ? numbers : undefined;
}

export function parseMetadataArg(
  raw: string | undefined,
  filePath: string | undefined
): Record<string, unknown> | undefined {
  if (raw === undefined && filePath === undefined) return undefined;

  const input =
    raw !== undefined ? raw : readFileSync(filePath as string, 'utf-8');

  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('metadata must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error: any) {
    throw new Error(error?.message || 'Invalid metadata JSON.');
  }
}

export function parseEndpointFeedbackEndpoint(
  value: string
): EndpointFeedbackEndpoint {
  const endpoint = value.toLowerCase();
  if (
    !ENDPOINT_FEEDBACK_ENDPOINTS.includes(endpoint as EndpointFeedbackEndpoint)
  ) {
    throw new Error(
      `endpoint must be one of: ${ENDPOINT_FEEDBACK_ENDPOINTS.join(', ')}`
    );
  }
  return endpoint as EndpointFeedbackEndpoint;
}

export function parseEndpointFeedbackRating(
  value: string
): SearchFeedbackRating {
  const rating = value.toLowerCase();
  if (!['good', 'bad', 'partial'].includes(rating)) {
    throw new Error('--rating must be one of: good, bad, partial');
  }
  return rating as SearchFeedbackRating;
}

export function isEndpointFeedbackDisabledLocally(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  for (const key of ENDPOINT_FEEDBACK_OPT_OUT_ENV_VARS) {
    const value = env[key];
    if (typeof value === 'string' && TRUTHY.has(value.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

export function parseEndpointFeedbackCliOptions(options: {
  issues?: string;
  tags?: string;
  pageNumbers?: string;
  metadata?: string;
  metadataFile?: string;
  valuableSources?: string;
  missingContent?: string | string[];
  rating?: string;
}) {
  return {
    rating: parseEndpointFeedbackRating(String(options.rating || '')),
    issues: parseFeedbackListArg(options.issues, '--issues'),
    tags: parseFeedbackListArg(options.tags, '--tags'),
    pageNumbers: parsePageNumbersArg(options.pageNumbers),
    metadata: parseMetadataArg(options.metadata, options.metadataFile),
    valuableSources: parseValuableSourcesArg(options.valuableSources),
    missingContent: parseMissingContentArg(options.missingContent),
  };
}

export async function executeEndpointFeedback(
  options: EndpointFeedbackOptions
): Promise<EndpointFeedbackResult> {
  if (isEndpointFeedbackDisabledLocally()) {
    return {
      success: true,
      disabled: true,
      disabledSource: 'env',
      creditsRefunded: 0,
    };
  }

  try {
    if (options.apiKey || options.apiUrl) {
      getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
    }

    const config = getConfig();
    const apiKey = options.apiKey || config.apiKey;
    const apiUrl = (options.apiUrl || config.apiUrl || DEFAULT_API_URL).replace(
      /\/$/,
      ''
    );
    if (!isCustomApiUrl(apiUrl)) {
      validateConfig(apiKey);
    }

    const body: Record<string, unknown> = {
      endpoint: options.endpoint,
      jobId: options.jobId,
      rating: options.rating,
      origin: 'cli',
      integration: 'cli',
    };

    const entries: Array<[string, unknown]> = [
      ['issues', normalizeList(options.issues)],
      ['tags', normalizeList(options.tags)],
      ['note', options.note],
      ['valuableSources', options.valuableSources],
      ['missingContent', options.missingContent],
      ['querySuggestions', options.querySuggestions],
      ['url', options.url],
      ['pageNumbers', options.pageNumbers],
      ['metadata', options.metadata],
    ];

    for (const [key, value] of entries) {
      if (value === undefined) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (typeof value === 'string' && value.trim().length === 0) continue;
      body[key] = value;
    }

    const response = await fetch(`${apiUrl}/v2/feedback`, {
      method: 'POST',
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data: Record<string, any> = await response
      .json()
      .catch(() => ({}) as Record<string, any>);

    if (!response.ok || data?.success !== true) {
      const errorMessage =
        (typeof data?.error === 'string' && data.error) ||
        `HTTP ${response.status}: ${response.statusText}`;
      const errorCode =
        typeof data?.feedbackErrorCode === 'string'
          ? (data.feedbackErrorCode as EndpointFeedbackErrorCode)
          : undefined;

      if (errorCode === 'TEAM_OPTED_OUT') {
        return {
          success: true,
          disabled: true,
          disabledSource: 'team',
          creditsRefunded: 0,
          warning:
            'Feedback is disabled for this team. Contact support to re-enable.',
        };
      }

      return {
        success: false,
        error: errorMessage,
        errorCode,
        status: response.status,
      };
    }

    return {
      success: true,
      feedbackId: data.feedbackId,
      creditsRefunded: data.creditsRefunded ?? 0,
      creditsRefundedToday:
        typeof data.creditsRefundedToday === 'number'
          ? data.creditsRefundedToday
          : undefined,
      dailyRefundCap:
        typeof data.dailyRefundCap === 'number'
          ? data.dailyRefundCap
          : undefined,
      dailyCapReached: data.dailyCapReached === true,
      alreadySubmitted: data.alreadySubmitted,
      warning: data.warning,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error?.message || 'Unknown error occurred',
    };
  }
}

function formatReadable(result: EndpointFeedbackResult): string {
  const lines: string[] = [];
  if (result.alreadySubmitted) {
    lines.push('Feedback already submitted for this job.');
  } else {
    lines.push('Feedback recorded.');
  }
  if (result.feedbackId) {
    lines.push(`Feedback ID: ${result.feedbackId}`);
  }
  lines.push(`Credits refunded: ${result.creditsRefunded ?? 0}`);
  if (
    typeof result.creditsRefundedToday === 'number' &&
    typeof result.dailyRefundCap === 'number'
  ) {
    lines.push(
      `Refunds today: ${result.creditsRefundedToday} / ${result.dailyRefundCap}`
    );
  }
  if (result.dailyCapReached) {
    lines.push(
      'Daily refund cap reached; further feedback calls today will not refund credits.'
    );
  }
  if (result.warning) {
    lines.push(`Warning: ${result.warning}`);
  }
  return lines.join('\n') + '\n';
}

export async function handleEndpointFeedbackCommand(
  options: EndpointFeedbackOptions
): Promise<void> {
  const result = await executeEndpointFeedback(options);

  if (result.disabled) {
    if (result.disabledSource === 'env') {
      process.exit(0);
    }
    if (options.silent) {
      process.exit(0);
    }
    console.error(result.warning ?? 'Feedback is disabled for this team.');
    process.exit(0);
  }

  if (!result.success) {
    if (options.silent) {
      process.exit(0);
    }
    console.error('Error:', result.error);
    if (result.errorCode) {
      console.error(`Code: ${result.errorCode}`);
    }
    process.exit(1);
  }

  if (options.silent) {
    return;
  }

  let outputContent: string;
  if (options.json || options.pretty) {
    const json: Record<string, unknown> = {
      success: true,
      feedbackId: result.feedbackId,
      creditsRefunded: result.creditsRefunded ?? 0,
      ...(typeof result.creditsRefundedToday === 'number'
        ? { creditsRefundedToday: result.creditsRefundedToday }
        : {}),
      ...(typeof result.dailyRefundCap === 'number'
        ? { dailyRefundCap: result.dailyRefundCap }
        : {}),
      ...(result.dailyCapReached ? { dailyCapReached: true } : {}),
      ...(result.alreadySubmitted ? { alreadySubmitted: true } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
    };
    outputContent = options.pretty
      ? JSON.stringify(json, null, 2)
      : JSON.stringify(json);
  } else {
    outputContent = formatReadable(result);
  }

  if (options.output) {
    const dir = dirname(options.output);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(options.output, outputContent, 'utf-8');
    console.error(`Output written to: ${options.output}`);
  } else {
    if (!outputContent.endsWith('\n')) outputContent += '\n';
    process.stdout.write(outputContent);
  }
}
