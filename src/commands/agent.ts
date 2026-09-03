/**
 * Agent command implementation
 */

import type {
  AgentEffort,
  AgentExchangeOptions,
  AgentMode,
  AgentOptions,
  AgentPendingApproval,
  AgentResult,
  AgentStatus,
  AgentStatusResult,
  AgentSuggestion,
  AgentThread,
  AgentThreadOptions,
  AgentThreadResult,
  AgentThreadRun,
} from '../types/agent';
import type { AgentStatusResponse, AgentWebhookConfig } from 'firecrawl';
import { getClient } from '../utils/client';
import { getConfig, validateConfig } from '../utils/config';
import {
  forgetThread,
  getRememberedThread,
  rememberThread,
} from '../utils/agent-threads';
import { isJobId } from '../utils/job';
import { writeOutput } from '../utils/output';
import { createSpinner } from '../utils/spinner';
import { readFileSync } from 'fs';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';

/**
 * Fixed prompts sent when resolving a pending approval, so the run continues
 * without the user retyping their intent.
 */
export const APPROVE_PROMPT = 'Approved. Make that call, and nothing else.';
export const DECLINE_PROMPT =
  'Do not make that call. Answer from what you already have, or tell me what you would need.';

const THREADS_UNSUPPORTED = 'This Firecrawl API does not support threads yet';

/**
 * firecrawl@4.24.0 predates threads: `prepareAgentPayload` whitelists request
 * keys (so threadId/mode/effort/exchange would be dropped) and the response
 * types omit the new fields (which the API does return). Starts that use the
 * new fields therefore go over raw HTTP — the same escape hatch monitor.ts and
 * parse.ts use — and status responses are read through a widened type. Both
 * workarounds can go once the SDK ships the fields from spec 11.3; the pinned
 * version here is 4.24.0.
 */
type ThreadAwareAgentStatus = AgentStatusResponse & {
  threadId?: string;
  threadTurn?: number;
  mode?: AgentMode;
  message?: string;
  suggestions?: AgentSuggestion[];
  pendingApproval?: AgentPendingApproval;
};

type ThreadAwareStartResponse = {
  success: boolean;
  id: string;
  threadId?: string;
  threadTurn?: number;
  error?: string;
};

class AgentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = 'AgentApiError';
  }
}

function resolveApiBase(options: { apiKey?: string; apiUrl?: string }): {
  baseUrl: string;
  apiKey?: string;
} {
  const config = getConfig();
  const apiKey = options.apiKey || config.apiKey;
  const baseUrl = (options.apiUrl || config.apiUrl || DEFAULT_API_URL).replace(
    /\/$/,
    ''
  );
  // Whether a key is required is decided by the server this request resolved
  // to, not by what `firecrawl config` happens to hold: `--api-url` alone
  // points at a self-hosted server, and those need no key.
  if (baseUrl === DEFAULT_API_URL) {
    validateConfig(apiKey);
  }
  return { baseUrl, apiKey };
}

async function agentApiRequest(
  path: string,
  options: { apiKey?: string; apiUrl?: string },
  init: { method?: string; body?: unknown } = {}
): Promise<any> {
  const { baseUrl, apiKey } = resolveApiBase(options);

  const headers: Record<string, string> = { 'X-Origin': 'cli' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const payload = (await response.json().catch(() => ({}))) as any;

  if (!response.ok || payload?.success === false) {
    const message =
      payload?.error ||
      `HTTP ${response.status}: ${response.statusText || 'Request failed'}`;
    throw new AgentApiError(message, response.status, payload?.code);
  }

  return payload;
}

/**
 * An old API rejects the thread fields with a 400 from its strict schema, and a
 * deployment without threads reports them as disabled. Both mean the same thing
 * to the user.
 */
function mapThreadSupportError(error: unknown): string | null {
  if (!(error instanceof AgentApiError)) return null;
  if (error.status === 503 && error.code === 'threads_disabled') {
    return THREADS_UNSUPPORTED;
  }
  if (error.status !== 400) return null;
  const namesUnknownKey =
    /unrecognized|unknown key|unexpected key|not allowed|not recognized/i.test(
      error.message
    );
  const namesThreadField = /threadId|thread_id|\bmode\b|exchange|effort/i.test(
    error.message
  );
  return namesUnknownKey && namesThreadField ? THREADS_UNSUPPORTED : null;
}

function isThreadGoneError(error: unknown): boolean {
  if (!(error instanceof AgentApiError)) return false;
  if (error.status === 404 || error.status === 410) return true;
  return (
    error.code === 'thread_not_found' ||
    error.code === 'thread_expired' ||
    /thread_not_found|thread_expired/.test(error.message)
  );
}

export interface AgentStartParams {
  prompt: string;
  urls?: string[];
  schema?: Record<string, unknown>;
  /** Send `urls: []`, which the API reads as "drop the thread's URLs" */
  clearUrls?: boolean;
  /** Send `schema: null`, which the API reads as "drop the thread's schema" */
  clearSchema?: boolean;
  model?: string;
  maxCredits?: number;
  webhook?: string | AgentWebhookConfig;
  threadId?: string;
  mode?: AgentMode;
  effort?: AgentEffort;
  exchange?: AgentExchangeOptions;
}

/** Request body for POST /v2/agent. New keys are only sent when set. */
export function buildAgentStartBody(
  params: AgentStartParams
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: params.prompt,
    integration: 'cli',
  };

  // A follow-up inherits the previous turn's URLs and schema unless it sends an
  // empty list or an explicit null, so clearing is its own request key rather
  // than an absent one.
  if (params.urls && params.urls.length > 0) body.urls = params.urls;
  else if (params.clearUrls) body.urls = [];
  if (params.schema) body.schema = params.schema;
  else if (params.clearSchema) body.schema = null;
  if (params.model) body.model = params.model;
  if (params.maxCredits !== undefined) body.maxCredits = params.maxCredits;
  if (params.webhook) body.webhook = params.webhook;
  if (params.threadId) body.threadId = params.threadId;
  if (params.mode) body.mode = params.mode;
  if (params.effort) body.effort = params.effort;
  if (params.exchange && Object.keys(params.exchange).length > 0) {
    body.exchange = params.exchange;
  }

  return body;
}

/** True when the request needs fields the pinned SDK cannot send. */
function needsRawStart(params: AgentStartParams): boolean {
  return Boolean(
    params.threadId ||
    params.mode ||
    params.effort ||
    params.exchange ||
    params.clearUrls ||
    params.clearSchema
  );
}

/**
 * Which thread this run continues, if any. `--thread` wins over `--continue`,
 * `--continue` falls back to the thread remembered for this API key, and
 * `--approve`/`--decline` continue that same thread without asking for a flag.
 */
export function resolveThreadIntent(
  options: Pick<
    AgentOptions,
    'thread' | 'continue' | 'new' | 'exchange' | 'apiKey'
  >,
  remembered: string | null
): { threadId?: string; fromMemory: boolean; missingMemory: boolean } {
  if (options.thread) {
    return {
      threadId: options.thread,
      fromMemory: false,
      missingMemory: false,
    };
  }

  const resolvingApproval = Boolean(
    options.exchange?.approve || options.exchange?.decline
  );
  const wantsContinue = Boolean(options.continue) || resolvingApproval;

  if (!wantsContinue || options.new) {
    return { fromMemory: false, missingMemory: false };
  }

  if (!remembered) {
    return { fromMemory: false, missingMemory: true };
  }

  return { threadId: remembered, fromMemory: true, missingMemory: false };
}

/**
 * Extract detailed error message from API errors
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const anyError = error as any;

    // Handle Firecrawl SDK errors with details array
    if (anyError.details && Array.isArray(anyError.details)) {
      const messages = anyError.details
        .map((d: any) => d.message || JSON.stringify(d))
        .join('; ');
      return messages || error.message;
    }

    // Check for response data in the error (common in axios/fetch errors)
    if (anyError.response?.data?.error) {
      return anyError.response.data.error;
    }
    if (anyError.response?.data?.message) {
      return anyError.response.data.message;
    }
    if (anyError.response?.data) {
      return JSON.stringify(anyError.response.data);
    }

    return error.message;
  }
  return 'Unknown error occurred';
}

/**
 * Load schema from file
 */
function loadSchemaFromFile(filePath: string): Record<string, unknown> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Schema file not found: ${filePath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in schema file: ${filePath}`);
    }
    throw error;
  }
}

type AgentStatusFromApi = 'processing' | 'completed' | 'failed';

function normalizeAgentStatus(status: AgentStatusFromApi): AgentStatus {
  return status as AgentStatus;
}

/** Thread-aware status fields the API returns and the pinned SDK does not type */
function threadFields(
  status: AgentStatusResponse
): Partial<NonNullable<AgentStatusResult['data']>> {
  const s = status as ThreadAwareAgentStatus;
  return {
    ...(s.threadId ? { threadId: s.threadId } : {}),
    ...(s.threadTurn !== undefined ? { threadTurn: s.threadTurn } : {}),
    ...(s.mode ? { mode: s.mode } : {}),
    ...(s.message ? { message: s.message } : {}),
    ...(s.suggestions && s.suggestions.length > 0
      ? { suggestions: s.suggestions }
      : {}),
    ...(s.pendingApproval ? { pendingApproval: s.pendingApproval } : {}),
  };
}

/**
 * Execute agent status check (with optional wait/polling)
 */
async function checkAgentStatus(
  jobId: string,
  options: AgentOptions
): Promise<AgentStatusResult> {
  const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });

  // If not waiting, just return current status
  if (!options.wait) {
    try {
      const status = await app.getAgentStatus(jobId);
      const normalizedStatus = normalizeAgentStatus(
        status.status as AgentStatusFromApi
      );
      const isCancelled = normalizedStatus === 'cancelled';

      return {
        success: isCancelled ? true : status.success,
        data: {
          id: jobId,
          status: normalizedStatus,
          data: status.data,
          creditsUsed: status.creditsUsed,
          expiresAt: status.expiresAt,
          ...threadFields(status),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: extractErrorMessage(error),
      };
    }
  }

  // Wait mode: poll until completion
  const spinner = createSpinner(`Checking agent status...`);
  spinner.start();

  // Handle Ctrl+C gracefully
  const handleInterrupt = () => {
    spinner.stop();
    process.stderr.write('\n\nInterrupted. Agent may still be running.\n');
    process.stderr.write(`Check status with: firecrawl agent ${jobId}\n\n`);
    process.exit(0);
  };
  process.on('SIGINT', handleInterrupt);

  const pollMs = options.pollInterval ? options.pollInterval * 1000 : 5000;
  const startTime = Date.now();
  const timeoutMs = options.timeout ? options.timeout * 1000 : undefined;

  try {
    // Check initial status
    let agentStatus = await app.getAgentStatus(jobId);
    const normalizedStatusInitial = normalizeAgentStatus(
      agentStatus.status as AgentStatusFromApi
    );
    spinner.update(`Agent ${normalizedStatusInitial}... (Job ID: ${jobId})`);

    while (true) {
      const currentNormalizedStatus = normalizeAgentStatus(agentStatus.status);

      if (currentNormalizedStatus === 'completed') {
        spinner.succeed('Agent completed');
        return {
          success: agentStatus.success,
          data: {
            id: jobId,
            status: currentNormalizedStatus,
            data: agentStatus.data,
            creditsUsed: agentStatus.creditsUsed,
            expiresAt: agentStatus.expiresAt,
            ...threadFields(agentStatus),
          },
        };
      }

      if (currentNormalizedStatus === 'failed') {
        spinner.fail('Agent failed');
        return {
          success: false,
          data: {
            id: jobId,
            status: currentNormalizedStatus,
            data: agentStatus.data,
            creditsUsed: agentStatus.creditsUsed,
            expiresAt: agentStatus.expiresAt,
            ...threadFields(agentStatus),
          },
          error: agentStatus.error,
        };
      }

      if (currentNormalizedStatus === 'cancelled') {
        spinner.succeed('Agent cancelled');
        return {
          success: true,
          data: {
            id: jobId,
            status: currentNormalizedStatus,
            data: agentStatus.data,
            creditsUsed: agentStatus.creditsUsed,
            expiresAt: agentStatus.expiresAt,
            ...threadFields(agentStatus),
          },
        };
      }

      // Check timeout
      if (timeoutMs && Date.now() - startTime > timeoutMs) {
        spinner.fail(`Timeout after ${options.timeout}s`);
        return {
          success: false,
          error: `Timeout after ${options.timeout} seconds. Agent still processing.`,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
      agentStatus = await app.getAgentStatus(jobId);
      const loopNormalizedStatus = normalizeAgentStatus(
        agentStatus.status as AgentStatusFromApi
      );
      spinner.update(`Agent ${loopNormalizedStatus}... (Job ID: ${jobId})`);
    }
  } catch (error) {
    spinner.fail('Failed to check agent status');
    return {
      success: false,
      error: extractErrorMessage(error),
    };
  } finally {
    process.removeListener('SIGINT', handleInterrupt);
  }
}

/**
 * Prompt to send for this turn. Resolving an approval carries its own fixed
 * prompt so the user does not have to restate anything.
 */
export function resolveStartPrompt(
  options: Pick<AgentOptions, 'prompt' | 'exchange'>
): string {
  if (options.prompt && options.prompt.trim()) return options.prompt;
  if (options.exchange?.approve) return APPROVE_PROMPT;
  if (options.exchange?.decline) return DECLINE_PROMPT;
  return options.prompt;
}

/**
 * Start a run, continuing a thread when one is asked for or remembered, and
 * record the thread the API reports back.
 */
async function startAgentRun(
  options: AgentOptions,
  params: AgentStartParams,
  onNotice: (message: string) => void
): Promise<ThreadAwareStartResponse> {
  const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });

  const attempt = async (
    attemptParams: AgentStartParams
  ): Promise<ThreadAwareStartResponse> => {
    try {
      if (!needsRawStart(attemptParams)) {
        const response = await app.startAgent({
          prompt: attemptParams.prompt,
          ...(attemptParams.urls ? { urls: attemptParams.urls } : {}),
          ...(attemptParams.schema ? { schema: attemptParams.schema } : {}),
          ...(attemptParams.model
            ? { model: attemptParams.model as 'spark-1-pro' | 'spark-1-mini' }
            : {}),
          ...(attemptParams.maxCredits !== undefined
            ? { maxCredits: attemptParams.maxCredits }
            : {}),
          ...(attemptParams.webhook ? { webhook: attemptParams.webhook } : {}),
          integration: 'cli',
        });
        return response as ThreadAwareStartResponse;
      }

      return (await agentApiRequest('/v2/agent', options, {
        method: 'POST',
        body: buildAgentStartBody(attemptParams),
      })) as ThreadAwareStartResponse;
    } catch (error) {
      const unsupported = mapThreadSupportError(error);
      if (unsupported) throw new Error(unsupported);
      throw error;
    }
  };

  // The server and the key this run will actually use, which is rarely what
  // `--api-key` carried: it usually comes from the environment or from stored
  // credentials, and keying memory off the flag alone would put every one of
  // those runs in the same bucket.
  const identity = resolveApiBase(options);
  const remembered = getRememberedThread(identity)?.lastThreadId ?? null;
  const intent = resolveThreadIntent(options, remembered);

  // An approval only exists inside a thread, so there is nothing to resolve
  // without one.
  const resolvingApproval = Boolean(
    params.exchange?.approve || params.exchange?.decline
  );
  if (resolvingApproval && !intent.threadId) {
    throw new Error(
      'No thread to resolve that approval in. Pass --thread <id>.'
    );
  }

  if (intent.missingMemory) {
    onNotice('No remembered thread; starting a new one.');
  }

  let response: ThreadAwareStartResponse;
  try {
    response = await attempt({ ...params, threadId: intent.threadId });
  } catch (error) {
    if (!isThreadGoneError(error)) throw error;

    if (intent.threadId && intent.threadId === remembered) {
      forgetThread(identity);
    }

    // A lost thread is a hard error while resolving an approval: there is
    // nothing to approve in a fresh one.
    if (!intent.fromMemory || resolvingApproval) throw error;

    onNotice('That thread is gone; starting a new one.');
    response = await attempt({ ...params, threadId: undefined });
  }

  if (response?.threadId) {
    rememberThread(identity, {
      threadId: response.threadId,
      runId: response.id,
    });
  }

  return response;
}

/**
 * Execute agent command
 */
export async function executeAgent(
  options: AgentOptions
): Promise<AgentResult | AgentStatusResult> {
  try {
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
    const { status, cancel, wait, pollInterval, timeout } = options;
    const prompt = resolveStartPrompt(options);

    if (cancel) {
      const cancelled = await app.cancelAgent(prompt);
      if (!cancelled) {
        return {
          success: false,
          error: `Failed to cancel agent job ${prompt}`,
        };
      }

      return {
        success: true,
        data: {
          id: prompt,
          status: 'cancelled',
        },
      };
    }

    // If status flag is set or input looks like a job ID, check status
    if (status || isJobId(prompt)) {
      return await checkAgentStatus(prompt, options);
    }

    // Load schema from file if specified
    let schema: Record<string, unknown> | undefined = options.schema as
      | Record<string, unknown>
      | undefined;
    if (options.schemaFile) {
      schema = loadSchemaFromFile(options.schemaFile);
    }

    // Build agent options
    const agentParams: AgentStartParams = { prompt };

    if (options.urls && options.urls.length > 0) {
      agentParams.urls = options.urls;
    }
    if (schema) {
      agentParams.schema = schema;
    }
    if (options.clearUrls) {
      agentParams.clearUrls = true;
    }
    if (options.clearSchema) {
      agentParams.clearSchema = true;
    }
    if (options.model) {
      agentParams.model = options.model;
    }
    if (options.maxCredits !== undefined) {
      agentParams.maxCredits = options.maxCredits;
    }
    if (options.webhook) {
      agentParams.webhook = options.webhook;
    }
    if (options.mode) {
      agentParams.mode = options.mode;
    }
    if (options.effort) {
      agentParams.effort = options.effort;
    }
    if (options.exchange && Object.keys(options.exchange).length > 0) {
      agentParams.exchange = options.exchange;
    }

    // If wait mode, use polling with spinner
    if (wait) {
      const spinner = createSpinner('Starting agent...');
      spinner.start();

      const notice = (message: string) => {
        spinner.stop();
        process.stderr.write(`${message}\n`);
        spinner.start();
      };

      // Start agent first
      let response: ThreadAwareStartResponse;
      try {
        response = await startAgentRun(options, agentParams, notice);
      } catch (error) {
        spinner.fail('Failed to start agent');
        return {
          success: false,
          error: extractErrorMessage(error),
        };
      }
      const jobId = response.id;
      const threadId = response.threadId;

      // Handle Ctrl+C gracefully
      const handleInterrupt = () => {
        spinner.stop();
        process.stderr.write('\n\nInterrupted. Agent is still running.\n');
        process.stderr.write(`Check status with: firecrawl agent ${jobId}\n\n`);
        process.exit(0);
      };
      process.on('SIGINT', handleInterrupt);

      spinner.update(`Agent running... (Job ID: ${jobId})`);

      // Poll for status
      const pollMs = pollInterval ? pollInterval * 1000 : 5000;
      const startTime = Date.now();
      const timeoutMs = timeout ? timeout * 1000 : undefined;

      try {
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));

          const agentStatus = await app.getAgentStatus(jobId);
          const normalizedStatus = normalizeAgentStatus(agentStatus.status);

          if (normalizedStatus === 'completed') {
            process.removeListener('SIGINT', handleInterrupt);
            spinner.succeed('Agent completed');
            return {
              success: agentStatus.success,
              data: {
                id: jobId,
                status: normalizedStatus,
                data: agentStatus.data,
                creditsUsed: agentStatus.creditsUsed,
                expiresAt: agentStatus.expiresAt,
                ...(threadId ? { threadId } : {}),
                ...threadFields(agentStatus),
              },
            };
          }

          if (normalizedStatus === 'failed') {
            process.removeListener('SIGINT', handleInterrupt);
            spinner.fail('Agent failed');
            return {
              success: false,
              data: {
                id: jobId,
                status: normalizedStatus,
                data: agentStatus.data,
                creditsUsed: agentStatus.creditsUsed,
                expiresAt: agentStatus.expiresAt,
                ...(threadId ? { threadId } : {}),
                ...threadFields(agentStatus),
              },
              error: agentStatus.error,
            };
          }

          // Check timeout
          if (timeoutMs && Date.now() - startTime > timeoutMs) {
            process.removeListener('SIGINT', handleInterrupt);
            spinner.fail(`Timeout after ${timeout}s (Job ID: ${jobId})`);
            return {
              success: false,
              error: `Timeout after ${timeout} seconds. Agent still processing. Job ID: ${jobId}`,
            };
          }
        }
      } finally {
        process.removeListener('SIGINT', handleInterrupt);
      }
    }

    // Otherwise, start agent and return job ID
    const spinner = createSpinner('Starting agent...');
    spinner.start();

    const notice = (message: string) => {
      spinner.stop();
      process.stderr.write(`${message}\n`);
      spinner.start();
    };

    let response: ThreadAwareStartResponse;
    try {
      response = await startAgentRun(options, agentParams, notice);
    } catch (error) {
      spinner.fail('Failed to start agent');
      return {
        success: false,
        error: extractErrorMessage(error),
      };
    }

    spinner.succeed(`Agent started (Job ID: ${response.id})`);

    return {
      success: response.success,
      data: {
        jobId: response.id,
        status: 'processing',
        ...(response.threadId ? { threadId: response.threadId } : {}),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: extractErrorMessage(error),
    };
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length))
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) =>
        i === cells.length - 1 ? cell : cell.padEnd(widths[i])
      )
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

/**
 * Render an approval the run is waiting on, plus the commands that resolve it.
 * Everything shown comes straight off the API response.
 */
export function formatPendingApproval(
  pendingApproval: AgentPendingApproval
): string {
  const lines: string[] = [];
  lines.push(`Awaiting approval: ${pendingApproval.id}`);

  if (typeof pendingApproval.reason === 'string' && pendingApproval.reason) {
    lines.push(pendingApproval.reason);
  }

  const calls = Array.isArray(pendingApproval.calls)
    ? pendingApproval.calls
    : [];
  if (calls.length > 0) {
    const rows = calls.map((call) => {
      const args =
        (call.input as unknown) ??
        (call as Record<string, unknown>).arguments ??
        (call as Record<string, unknown>).parameters;
      const credits = call.creditsEstimate;
      return [
        String(call.provider ?? ''),
        String(call.capability ?? ''),
        args === undefined ? '' : truncate(JSON.stringify(args), 80),
        credits === undefined || credits === null ? '-' : String(credits),
      ];
    });
    lines.push(
      ...renderTable(
        ['Provider', 'Capability', 'Arguments', 'Est. credits'],
        rows
      )
    );
  }

  lines.push(`  firecrawl agent --approve ${pendingApproval.id}`);
  lines.push(`  firecrawl agent --decline ${pendingApproval.id}`);

  return lines.join('\n');
}

/**
 * A shell word that is only ever a word. Single quotes suspend every
 * expansion a shell performs, and the one character they cannot carry is
 * closed, escaped and reopened.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render follow-ups as the commands that run them.
 *
 * These come back from the server and are printed for someone to copy, so
 * they are quoted to be inert. Double quotes would leave `$(...)`, backticks
 * and `${...}` live, and a suggestion is not worth a shell substitution.
 */
export function formatSuggestions(suggestions: AgentSuggestion[]): string {
  const lines: string[] = ['Try next:'];
  for (const suggestion of suggestions) {
    const prompt = suggestion.prompt || suggestion.label;
    if (!prompt) continue;
    lines.push(`  firecrawl agent --continue ${shellQuote(prompt)}`);
  }
  return lines.join('\n');
}

/**
 * Format agent status in human-readable way
 */
function formatAgentStatus(data: AgentStatusResult['data']): string {
  if (!data) return '';

  const lines: string[] = [];

  // In chat mode the reply is the answer, so it leads the output
  if (data.message) {
    lines.push(data.message);
    lines.push('');
  }

  lines.push(`Job ID: ${data.id}`);
  lines.push(`Status: ${data.status}`);

  if (data.creditsUsed !== undefined) {
    lines.push(`Credits Used: ${data.creditsUsed}`);
  }

  if (data.expiresAt) {
    const expiresDate = new Date(data.expiresAt);
    lines.push(
      `Expires: ${expiresDate.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}`
    );
  }

  if (data.data) {
    lines.push('');
    lines.push('Result:');
    lines.push(JSON.stringify(data.data, null, 2));
  }

  if (data.pendingApproval) {
    lines.push('');
    lines.push(formatPendingApproval(data.pendingApproval));
  }

  if (data.suggestions && data.suggestions.length > 0) {
    lines.push('');
    lines.push(formatSuggestions(data.suggestions));
  }

  return lines.join('\n') + '\n';
}

/**
 * Handle agent command output
 */
export async function handleAgentCommand(options: AgentOptions): Promise<void> {
  const result = await executeAgent(options);

  if (!result.success) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  // Every start reports the thread it belongs to. It goes to stderr so piped
  // stdout keeps the shape callers already parse; --json carries it instead.
  const startedRun =
    !options.status && !options.cancel && !isJobId(options.prompt ?? '');
  const threadId =
    result.data && 'threadId' in result.data ? result.data.threadId : undefined;
  if (threadId && startedRun && !options.json) {
    process.stderr.write(`Thread: ${threadId}  (continue with --continue)\n`);
  }

  // Handle status result (completed agent job with data)
  if ('data' in result && result.data && 'data' in result.data) {
    const statusResult = result as AgentStatusResult;
    if (statusResult.data) {
      let outputContent: string;

      if (options.json) {
        // JSON format
        outputContent = options.pretty
          ? JSON.stringify({ success: true, ...statusResult.data }, null, 2)
          : JSON.stringify({ success: true, ...statusResult.data });
      } else {
        // Human-readable format
        outputContent = formatAgentStatus(statusResult.data);
      }

      writeOutput(outputContent, options.output, !!options.output);
      return;
    }
  }

  // Handle agent start result (job ID)
  const agentResult = result as AgentResult;
  if (!agentResult.data) {
    return;
  }

  let outputContent: string;

  if ('jobId' in agentResult.data) {
    const jobData = {
      jobId: agentResult.data.jobId,
      status: agentResult.data.status,
      ...(agentResult.data.threadId
        ? { threadId: agentResult.data.threadId }
        : {}),
    };

    outputContent = options.pretty
      ? JSON.stringify({ success: true, data: jobData }, null, 2)
      : JSON.stringify({ success: true, data: jobData });
  } else {
    outputContent = options.pretty
      ? JSON.stringify(agentResult.data, null, 2)
      : JSON.stringify(agentResult.data);
  }

  writeOutput(outputContent, options.output, !!options.output);
}

/**
 * Fetch one conversation. GET /v2/agent/threads/:id has no SDK method in
 * firecrawl@4.24.0, so it is called directly.
 */
export async function executeAgentThread(
  threadId: string,
  options: AgentThreadOptions = {}
): Promise<AgentThreadResult> {
  try {
    const payload = await agentApiRequest(
      `/v2/agent/threads/${encodeURIComponent(threadId)}?includeData=true`,
      options
    );
    const thread = (payload?.thread ?? payload?.data) as
      | AgentThread
      | undefined;
    if (!thread) {
      return { success: false, error: `Thread not found: ${threadId}` };
    }
    return { success: true, thread };
  } catch (error) {
    const unsupported = mapThreadSupportError(error);
    return {
      success: false,
      error: unsupported ?? extractErrorMessage(error),
    };
  }
}

function formatThreadRun(run: AgentThreadRun): string[] {
  const heading = [
    `Turn ${run.turn}`,
    run.mode,
    run.status,
    run.creditsUsed !== undefined && run.creditsUsed !== null
      ? `${run.creditsUsed} credits`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  const lines: string[] = [heading];

  if (run.prompt) {
    lines.push(`  You: ${run.prompt}`);
  }
  if (run.message) {
    lines.push(`  Agent: ${run.message}`);
  }
  if (run.data !== undefined && run.data !== null) {
    lines.push('  Result:');
    lines.push(JSON.stringify(run.data, null, 2));
  }
  if (run.pendingApproval) {
    lines.push(formatPendingApproval(run.pendingApproval));
  }
  if (run.suggestions && run.suggestions.length > 0) {
    lines.push(formatSuggestions(run.suggestions));
  }

  return lines;
}

/** Render a thread as its turns, oldest first */
export function formatThread(thread: AgentThread): string {
  const lines: string[] = [`Thread: ${thread.id}`];
  if (thread.status) lines.push(`Status: ${thread.status}`);
  if (thread.updatedAt) lines.push(`Updated: ${thread.updatedAt}`);

  const runs = [...(thread.runs ?? [])].sort((a, b) => a.turn - b.turn);
  for (const run of runs) {
    lines.push('');
    lines.push(...formatThreadRun(run));
  }

  return lines.join('\n') + '\n';
}

/**
 * Handle `firecrawl agent thread <id>` output
 */
export async function handleAgentThreadCommand(
  threadId: string,
  options: AgentThreadOptions = {}
): Promise<void> {
  const result = await executeAgentThread(threadId, options);

  if (!result.success || !result.thread) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  const outputContent = options.json
    ? JSON.stringify(
        { success: true, thread: result.thread },
        null,
        options.pretty ? 2 : 0
      )
    : formatThread(result.thread);

  writeOutput(outputContent, options.output, !!options.output);
}
