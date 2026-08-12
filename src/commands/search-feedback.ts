import { getConfig, validateConfig } from '../utils/config';
import { getClient } from '../utils/client';

export type SearchFeedbackRating = 'good' | 'bad' | 'partial';

export interface ValuableSourceInput {
  url: string;
  reason?: string;
}

export interface MissingContentInput {
  topic: string;
  description?: string;
}

export type SearchResultSource = 'web' | 'images' | 'news';

export const SEARCH_RESULT_SOURCES: readonly SearchResultSource[] = [
  'web',
  'images',
  'news',
];

// Search results come back grouped — data.web, data.images, data.news — and
// each group is numbered from 1 independently, so a position is only
// meaningful alongside the group it indexes into.
export interface ValuableResultInput {
  source: SearchResultSource;
  position: number;
  reason?: string;
}

export interface SearchFeedbackOptions {
  searchId: string;
  rating: SearchFeedbackRating;
  valuableSources?: ValuableSourceInput[];
  valuableResults?: ValuableResultInput[];
  missingContent?: MissingContentInput[];
  querySuggestions?: string;
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
  pretty?: boolean;
  silent?: boolean;
}

export type SearchFeedbackErrorCode =
  | 'SEARCH_NOT_FOUND'
  | 'FEEDBACK_WINDOW_EXPIRED'
  | 'SEARCH_FAILED'
  | 'PREVIEW_TEAM_NOT_ALLOWED'
  | 'TEAM_OPTED_OUT'
  | 'INVALID_BODY'
  | 'DB_DISABLED'
  | 'INTERNAL';

export interface SearchFeedbackResult {
  success: boolean;
  feedbackId?: string;
  creditsRefunded?: number;
  creditsRefundedToday?: number;
  dailyRefundCap?: number;
  dailyCapReached?: boolean;
  alreadySubmitted?: boolean;
  warning?: string;
  error?: string;
  errorCode?: SearchFeedbackErrorCode;
  // True when the call was skipped due to local or team opt-out; `success`
  // is also `true` so background callers (`--silent &`) do not error.
  disabled?: boolean;
  disabledSource?: 'env' | 'team';
}

export const SEARCH_FEEDBACK_OPT_OUT_ENV_VARS = [
  'FIRECRAWL_NO_SEARCH_FEEDBACK',
  'FIRECRAWL_DISABLE_SEARCH_FEEDBACK',
] as const;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function isSearchFeedbackDisabledLocally(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  for (const key of SEARCH_FEEDBACK_OPT_OUT_ENV_VARS) {
    const value = env[key];
    if (typeof value === 'string' && TRUTHY.has(value.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

const DEFAULT_API_URL = 'https://api.firecrawl.dev';

export async function executeSearchFeedback(
  options: SearchFeedbackOptions
): Promise<SearchFeedbackResult> {
  if (isSearchFeedbackDisabledLocally()) {
    return {
      success: true,
      disabled: true,
      disabledSource: 'env',
      creditsRefunded: 0,
      warning:
        'Search feedback disabled by FIRECRAWL_NO_SEARCH_FEEDBACK; no data was sent.',
    };
  }

  try {
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

    const url = `${apiUrl}/v2/search/${encodeURIComponent(options.searchId)}/feedback`;
    const body: Record<string, unknown> = {
      rating: options.rating,
      origin: 'cli',
      integration: 'cli',
    };

    if (options.valuableSources && options.valuableSources.length > 0) {
      body.valuableSources = options.valuableSources
        .filter((s) => !!s.url)
        .map((s) => ({
          url: s.url,
          ...(s.reason ? { reason: s.reason } : {}),
        }));
    }
    if (options.valuableResults && options.valuableResults.length > 0) {
      body.valuableResults = options.valuableResults;
    }
    if (options.missingContent && options.missingContent.length > 0) {
      body.missingContent = options.missingContent
        .filter((m) => !!m.topic)
        .map((m) => ({
          topic: m.topic,
          ...(m.description ? { description: m.description } : {}),
        }));
    }
    if (options.querySuggestions) {
      body.querySuggestions = options.querySuggestions;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
          ? (data.feedbackErrorCode as SearchFeedbackErrorCode)
          : undefined;

      if (errorCode === 'TEAM_OPTED_OUT') {
        return {
          success: true,
          disabled: true,
          disabledSource: 'team',
          creditsRefunded: 0,
          warning:
            'Search feedback is disabled for this team. Contact support to re-enable.',
        };
      }

      return { success: false, error: errorMessage, errorCode };
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

function formatReadable(result: SearchFeedbackResult): string {
  const lines: string[] = [];
  if (result.alreadySubmitted) {
    lines.push(`Feedback already submitted for this search.`);
  } else {
    lines.push(`Feedback recorded.`);
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
      'Daily refund cap reached — further /feedback calls today will not refund credits.'
    );
  }
  if (result.warning) {
    lines.push(`Warning: ${result.warning}`);
  }
  return lines.join('\n') + '\n';
}

export async function handleSearchFeedbackCommand(
  options: SearchFeedbackOptions
): Promise<void> {
  const result = await executeSearchFeedback(options);

  if (result.disabled) {
    if (options.silent) {
      process.exit(0);
    }
    if (result.disabledSource === 'env') {
      console.error(
        'Search feedback is disabled (FIRECRAWL_NO_SEARCH_FEEDBACK is set). ' +
          'Nothing was sent. Unset the env var to re-enable.'
      );
    } else {
      console.error(
        result.warning ?? 'Search feedback is disabled for this team.'
      );
    }
    process.exit(0);
  }

  if (!result.success) {
    // --silent always exits 0 so background pipelines don't crash; only
    // surface 5xx-class errors to stderr when explicit debugging is on.
    if (options.silent) {
      const noisy: SearchFeedbackErrorCode[] = ['INTERNAL', 'DB_DISABLED'];
      if (
        result.errorCode &&
        noisy.includes(result.errorCode) &&
        process.env.FIRECRAWL_SEARCH_FEEDBACK_DEBUG === '1'
      ) {
        console.error(
          `firecrawl search-feedback: ${result.errorCode}: ${result.error}`
        );
      }
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
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.dirname(options.output);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(options.output, outputContent, 'utf-8');
    console.error(`Output written to: ${options.output}`);
  } else {
    if (!outputContent.endsWith('\n')) outputContent += '\n';
    process.stdout.write(outputContent);
  }
}

export function parseValuableSourcesArg(
  raw: string | undefined
): ValuableSourceInput[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const cleaned: ValuableSourceInput[] = [];
      for (const entry of arr) {
        if (
          entry &&
          typeof entry === 'object' &&
          typeof entry.url === 'string'
        ) {
          cleaned.push({
            url: entry.url,
            ...(typeof entry.reason === 'string'
              ? { reason: entry.reason }
              : {}),
          });
        } else if (typeof entry === 'string') {
          cleaned.push({ url: entry });
        }
      }
      return cleaned.length > 0 ? cleaned : undefined;
    } catch {
      throw new Error(
        '--valuable-sources must be valid JSON or a comma-separated list of URLs.'
      );
    }
  }

  return trimmed
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0)
    .map((url) => ({ url }));
}

function isSearchResultSource(value: unknown): value is SearchResultSource {
  return (
    typeof value === 'string' &&
    (SEARCH_RESULT_SOURCES as readonly string[]).includes(value)
  );
}

function parsePositionValue(raw: unknown, flag: string): number {
  const position = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (
    typeof position !== 'number' ||
    !Number.isInteger(position) ||
    position < 1
  ) {
    throw new Error(`${flag} positions must be integers of 1 or greater.`);
  }
  return position;
}

// Accepts a compact "source:position" list (e.g. "web:1,news:2") or a JSON
// array of {source, position, reason} entries. The source is always required:
// results are grouped and each group is numbered from 1, so a bare position
// does not identify a result.
export function parseValuableResultsArg(
  raw: string | undefined,
  flag = '--valuable-results'
): ValuableResultInput[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const sourceList = SEARCH_RESULT_SOURCES.join(' | ');

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `${flag} must be valid JSON or a comma-separated "source:position" list.`
      );
    }

    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const cleaned = entries.map((entry: any) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(
          `${flag} JSON entries must be objects with a source and a position.`
        );
      }
      if (!isSearchResultSource(entry.source)) {
        throw new Error(`${flag} source must be one of: ${sourceList}.`);
      }
      return {
        source: entry.source,
        position: parsePositionValue(entry.position, flag),
        ...(typeof entry.reason === 'string' && entry.reason.trim()
          ? { reason: entry.reason }
          : {}),
      };
    });
    return cleaned.length > 0 ? cleaned : undefined;
  }

  const cleaned = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.lastIndexOf(':');
      if (separator === -1) {
        throw new Error(
          `${flag} entries must be "source:position" (e.g. web:1) — ` +
            `results are grouped, so a bare position is ambiguous.`
        );
      }
      const source = entry.slice(0, separator).trim();
      if (!isSearchResultSource(source)) {
        throw new Error(`${flag} source must be one of: ${sourceList}.`);
      }
      return {
        source,
        position: parsePositionValue(entry.slice(separator + 1), flag),
      };
    });

  return cleaned.length > 0 ? cleaned : undefined;
}

// Accepts JSON arrays/objects, "topic: description" strings, comma-
// separated topic lists, or repeated values. Caps at 20 entries.
export function parseMissingContentArg(
  raw: string | string[] | undefined
): MissingContentInput[] | undefined {
  if (!raw) return undefined;
  const inputs = Array.isArray(raw) ? raw : [raw];
  const out: MissingContentInput[] = [];

  for (const value of inputs) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of arr) {
          if (typeof entry === 'string') {
            const topic = entry.trim();
            if (topic) out.push({ topic });
          } else if (
            entry &&
            typeof entry === 'object' &&
            typeof entry.topic === 'string'
          ) {
            const topic = entry.topic.trim();
            if (!topic) continue;
            const description =
              typeof entry.description === 'string'
                ? entry.description.trim()
                : undefined;
            out.push({
              topic,
              ...(description ? { description } : {}),
            });
          }
        }
        continue;
      } catch {
        throw new Error(
          '--missing-content must be valid JSON, "topic: description" form, or a comma-separated topic list.'
        );
      }
    }

    for (const part of trimmed
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)) {
      const colonIdx = part.indexOf(':');
      if (colonIdx > 0) {
        const topic = part.slice(0, colonIdx).trim();
        const description = part.slice(colonIdx + 1).trim();
        if (topic) {
          out.push({
            topic,
            ...(description ? { description } : {}),
          });
        }
      } else {
        out.push({ topic: part });
      }
    }
  }

  if (out.length === 0) return undefined;
  return out.slice(0, 20);
}
