import { readFileSync } from 'node:fs';
import { receiptFor, printReceipt, printRetry } from '../utils/receipt';
import { randomUUID } from 'node:crypto';
import { Command, Option } from 'commander';
import { type AlexandriaCall } from 'firecrawl';
import { getClient } from '../utils/client';
import { getApiKey, getConfig } from '../utils/config';
import { integrationHeaders } from '../utils/integration';
import { writeOutput } from '../utils/output';
import {
  withCatalogResultPrices,
  withoutResultPrices,
} from '../utils/alexandria-prices';
import { TERMS_DASHBOARD_URL } from './terms';

type Call = AlexandriaCall & { options: Record<string, unknown> };
export type AlexandriaOptions = {
  apiKey?: string;
  apiUrl?: string;
  requestId?: string;
  timeout?: number;
  output?: string;
  json?: boolean;
  pretty?: boolean;
  showReceipt?: boolean;
  includeCosts?: boolean;
};

export function requireAlexandriaKey(apiKey?: string): void {
  if (!getApiKey(apiKey))
    throw new Error(
      'Alexandria requires a Firecrawl API key with access enabled.'
    );
}

export function parseToolOptions(raw = '{}'): Record<string, unknown> {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('--options must be a JSON object.');
  return value;
}

const FIND_TOOLS_LIST_SELECTORS = [
  'providers',
  'categories',
  'groups',
  'capabilities',
  'expand',
];

/**
 * Find Tools list selectors take arrays; also accept the comma-separated form.
 * `urls` is never comma-split (a comma is legal inside a URL); a single string is wrapped.
 */
export function normalizeFindToolsOptions(
  options: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...options };
  for (const key of FIND_TOOLS_LIST_SELECTORS) {
    const value = next[key];
    if (typeof value === 'string')
      next[key] = value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
  }
  if (typeof next.urls === 'string') next.urls = [next.urls.trim()];
  return next;
}

const ADDRESS_HINT =
  'Use a provider/capability address, or a JSON object {"provider":"...","capability":"...","options":{...}}.';

/** Accept both the bare `provider/capability` form and the HTTP contract's object form. */
function parseAddress(address: string): AlexandriaCall {
  const trimmed = address.trim();
  if (trimmed.startsWith('{')) {
    let value: any;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new Error(ADDRESS_HINT);
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.provider !== 'string' ||
      !value.provider.trim() ||
      typeof value.capability !== 'string' ||
      !value.capability.trim() ||
      (value.options !== undefined &&
        (!value.options ||
          typeof value.options !== 'object' ||
          Array.isArray(value.options))) ||
      Object.keys(value).some(
        (key) => !['provider', 'capability', 'options'].includes(key)
      )
    )
      throw new Error(ADDRESS_HINT);
    return {
      provider: value.provider.trim(),
      capability: value.capability.trim(),
      ...(value.options !== undefined && { options: value.options }),
    };
  }
  const slash = trimmed.indexOf('/');
  if (slash < 0) throw new Error(ADDRESS_HINT);
  const provider = trimmed.slice(0, slash).trim();
  const capability = trimmed.slice(slash + 1).trim();
  if (!provider || !capability) throw new Error(ADDRESS_HINT);
  return { provider, capability };
}

export function buildCalls(addresses: string[], values: string[] = []): Call[] {
  if (
    !addresses.length ||
    addresses.length > 10 ||
    values.length > addresses.length
  )
    throw new Error(
      'Provide 1-10 capabilities, with at most one --options value per capability.'
    );
  return addresses.map((address, i) => {
    const call = parseAddress(address);
    if (call.options !== undefined && values[i] !== undefined)
      throw new Error(
        `Provide options for ${call.provider}/${call.capability} either inside the object or with --options, not both.`
      );
    const options = call.options ?? parseToolOptions(values[i]);
    return {
      provider: call.provider,
      capability: call.capability,
      options:
        call.provider === 'firecrawl' && call.capability === 'find-tools'
          ? normalizeFindToolsOptions(options)
          : options,
    };
  });
}

export function apiFailure(error: unknown): Record<string, any> {
  const candidate = error as any;
  const body =
    candidate?.response?.data ?? candidate?.details ?? candidate ?? {};
  const headers = candidate?.response?.headers;
  const retryHeader =
    typeof headers?.get === 'function'
      ? headers.get('retry-after')
      : headers?.['retry-after'];
  const rawRetry =
    body?.retry_after_seconds ??
    body?.retryAfterSeconds ??
    body?.details?.retryAfterSeconds ??
    candidate?.retryAfterSeconds ??
    retryHeader;
  let retryAfterSeconds: number | undefined;
  if (
    typeof rawRetry === 'number' ||
    (typeof rawRetry === 'string' && /^\d+(\.\d+)?$/.test(rawRetry))
  ) {
    const seconds = Number(rawRetry);
    if (Number.isFinite(seconds) && seconds >= 0)
      retryAfterSeconds = Math.ceil(seconds);
  } else if (
    typeof retryHeader === 'string' &&
    /^[A-Za-z]{3}, /.test(retryHeader)
  ) {
    const timestamp = Date.parse(retryHeader);
    if (Number.isFinite(timestamp))
      retryAfterSeconds = Math.max(
        0,
        Math.ceil((timestamp - Date.now()) / 1000)
      );
  }
  const result: Record<string, any> = {
    success: false,
    error:
      typeof body?.error === 'string'
        ? body.error
        : error instanceof Error
          ? error.message
          : 'Request failed',
  };
  for (const key of [
    'code',
    'chargeId',
    'requestId',
    'scrapeId',
    'scrape_id',
    'id',
  ]) {
    const value = body?.[key] ?? candidate?.[key];
    if (typeof value === 'string') result[key] = value;
  }
  const status =
    candidate?.response?.status ?? candidate?.status ?? body?.status;
  if (typeof status === 'number') result.status = status;
  const action = body?.requiresAction ?? candidate?.requiresAction;
  if (action) result.requiresAction = action;
  if (retryAfterSeconds !== undefined)
    result.retryAfterSeconds = retryAfterSeconds;
  return result;
}

/** One automatic Find Tools retry waits at most this long. */
export const FIND_TOOLS_RETRY_CAP_SECONDS = 3;

export function isQueryEmbedUnavailable(
  failure: Record<string, any> | undefined
): boolean {
  return (
    failure?.success === false &&
    failure.status === 503 &&
    failure.code === 'query_embed_unavailable'
  );
}

/** Retry-After in milliseconds, capped so a long delay cannot stall the CLI. */
export function findToolsRetryDelayMs(retryAfterSeconds?: number): number {
  if (
    retryAfterSeconds === undefined ||
    !Number.isFinite(retryAfterSeconds) ||
    retryAfterSeconds <= 0
  )
    return 0;
  return Math.min(retryAfterSeconds, FIND_TOOLS_RETRY_CAP_SECONDS) * 1000;
}

const retryAfterByRequest = new Map<string, string>();

function headerValue(headers: any, name: string): string | undefined {
  if (!headers) return undefined;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (Array.isArray(direct) && typeof direct[0] === 'string')
    return direct[0].trim();
  if (typeof headers.get === 'function') {
    const value = headers.get(name) ?? headers.get(name.toLowerCase());
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function captureRetryAfter(client: unknown): void {
  const instance = (
    client as {
      http?: { instance?: { interceptors?: any; __fcRetryAfter?: boolean } };
    }
  ).http?.instance;
  if (!instance?.interceptors || instance.__fcRetryAfter) return;
  instance.__fcRetryAfter = true;
  const save = (headers: any, config: any) => {
    const retry = headerValue(headers, 'retry-after');
    const requestId = headerValue(config?.headers, 'x-request-id');
    if (retry && requestId) retryAfterByRequest.set(requestId, retry);
  };
  instance.interceptors.response.use(
    (response: any) => {
      save(response?.headers, response?.config);
      return response;
    },
    (error: any) => {
      save(error?.response?.headers, error?.config ?? error?.response?.config);
      return Promise.reject(error);
    }
  );
}

function rememberRetryHeader(error: unknown, requestId: string): void {
  const retry = retryAfterByRequest.get(requestId);
  retryAfterByRequest.delete(requestId);
  if (!retry || !error || typeof error !== 'object') return;
  const record = error as any;
  if (headerValue(record.response?.headers, 'retry-after')) return;
  record.response = {
    ...(record.response ?? {}),
    headers: { ...(record.response?.headers ?? {}), 'retry-after': retry },
  };
}

function isFindToolsRequest(calls: Call[]): boolean {
  return (
    calls.length > 0 &&
    calls.every(
      (call) =>
        call.provider === 'firecrawl' && call.capability === 'find-tools'
    )
  );
}

const QUERY_EMBED_RETRY_ERROR =
  'Find Tools query embedding is temporarily unavailable (query_embed_unavailable). Retry this command.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestAlexandria(
  calls: Call[],
  options: AlexandriaOptions
): Promise<Record<string, any>> {
  const requestId = options.requestId ?? randomUUID();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId))
    throw new Error('Invalid --request-id.');
  requireAlexandriaKey(options.apiKey);
  // Print before execution so even an interrupted request can reuse its identity.
  if (options.showReceipt !== false) console.error(`Request ID: ${requestId}`);
  const execute = async (): Promise<Record<string, any>> => {
    try {
      const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
      captureRetryAfter(app);
      const result = await app.scrape({
        alexandria: calls,
        integration: 'cli',
        timeout: options.timeout,
        requestId,
      });
      return {
        success: true,
        ...(result.scrapeId && { scrape_id: result.scrapeId }),
        data: {
          alexandria: result.alexandria,
          creditsCost: result.creditsCost,
        },
      };
    } catch (error) {
      rememberRetryHeader(error, requestId);
      return apiFailure(error);
    }
  };
  let envelope = await execute();
  // Find Tools embedding is briefly unavailable on its own. Retry the same
  // request once; a paid batch is never repeated from this path.
  if (isFindToolsRequest(calls) && isQueryEmbedUnavailable(envelope)) {
    const delay = findToolsRetryDelayMs(envelope.retryAfterSeconds);
    console.error(
      'Find Tools query embedding is temporarily unavailable. Retrying once.'
    );
    if (delay > 0) await sleep(delay);
    envelope = await execute();
    if (isQueryEmbedUnavailable(envelope)) {
      envelope.error = QUERY_EMBED_RETRY_ERROR;
      envelope.retryable = true;
    }
  }
  const receipt = receiptFor(envelope, 'scrape', requestId);
  if (options.showReceipt !== false) printReceipt(receipt, false);
  printRetry(envelope);
  const shown = options.includeCosts
    ? withCatalogResultPrices(envelope)
    : withoutResultPrices(envelope);
  return {
    ...shown,
    requestId,
    receipt,
  };
}

/** App page for a team skill. The slug has no `team:` prefix. */
export const SKILL_APP_ORIGIN =
  'https://www.firecrawl.dev/app/alexandria/skills';

/** Skill slug from a slug or `team:<slug>` id. A path or other prefix is refused. */
export function teamSkillSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let slug = value.trim();
  if (slug.startsWith('team:')) slug = slug.slice('team:'.length).trim();
  if (
    !slug ||
    slug.length > 200 ||
    slug === '.' ||
    slug === '..' ||
    /[/\\:]/.test(slug)
  )
    return undefined;
  return slug;
}

/**
 * Page for a successful create-skill or update-skill.
 * Uses the skill slug, or the id with `team:` removed. Ignores sharePath.
 */
export function skillAppUrl(envelope: Record<string, any>): string | undefined {
  if (!envelope?.success || !Array.isArray(envelope.data?.alexandria))
    return undefined;
  for (const entry of envelope.data.alexandria) {
    if (
      !entry ||
      entry.error ||
      (entry.capability !== 'create-skill' &&
        entry.capability !== 'update-skill')
    )
      continue;
    const data = entry.data;
    const slug =
      teamSkillSlug(data?.skill?.slug) ??
      teamSkillSlug(data?.slug) ??
      teamSkillSlug(data?.skill?.skillId) ??
      teamSkillSlug(data?.id);
    if (!slug) continue;
    return `${SKILL_APP_ORIGIN}/${encodeURIComponent(slug)}`;
  }
  return undefined;
}

function emitAlexandria(
  envelope: Record<string, any>,
  options: AlexandriaOptions
): void {
  const failed =
    !envelope.success ||
    envelope.data?.alexandria?.some((item: any) => item.error);
  if (failed) process.exitCode = 1;
  if (envelope.code === 'THIRD_PARTY_DATA_TERMS_REQUIRED') {
    const url = envelope.requiresAction?.url || TERMS_DASHBOARD_URL;
    envelope.guidance = `An organization admin must accept this provider's terms in the Firecrawl dashboard: ${url}. Give the user this link; they can review the terms first with firecrawl alexandria terms show <provider>. Do not retry until the terms are accepted.`;
    console.error(envelope.guidance);
  }
  const skillUrl = failed ? undefined : skillAppUrl(envelope);
  if (skillUrl) {
    envelope.url = skillUrl;
    console.error(skillUrl);
  }
  writeOutput(
    JSON.stringify(envelope, null, options.pretty ? 2 : undefined),
    options.output,
    !!options.output
  );
}

export async function handleAlexandria(
  calls: Call[],
  options: AlexandriaOptions
): Promise<void> {
  emitAlexandria(await requestAlexandria(calls, options), options);
}

export function isExecutionOnlySkill(skill: any): boolean {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) return false;
  if (skill.executionOnly === true || skill.execution_only === true)
    return true;
  return [
    skill.visibility,
    skill.listing,
    skill.mode,
    skill.kind,
    skill.purpose,
  ].some((value) => {
    if (typeof value !== 'string') return false;
    const normalized = value.toLowerCase().replace(/_/g, '-').trim();
    return (
      normalized === 'execution' ||
      normalized === 'execution-only' ||
      normalized === 'execute'
    );
  });
}

/** Provider slug from a string or `{ slug, name }`. */
export function providerSlugOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const slug = (value as { slug?: unknown }).slug;
  return typeof slug === 'string' && slug.trim() ? slug.trim() : undefined;
}

/** Plugin id from a string or `{ id, displayName }`. */
export function pluginIdOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as { id?: unknown; slug?: unknown };
  const id = record.id ?? record.slug;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

/** Skill slug from `skill`, or the last segment of `provider:.../plugin/skill`. */
export function skillSlugOf(skill: any): string | undefined {
  if (
    typeof skill?.skill === 'string' &&
    skill.skill.trim() &&
    !/[/\\]/.test(skill.skill)
  )
    return skill.skill.trim();
  if (typeof skill?.id !== 'string') return undefined;
  const last = skill.id.split('/').pop()?.trim();
  if (!last || last === '.' || last === '..' || last.includes(':'))
    return undefined;
  return last;
}

function collectSkillRecords(
  body: any,
  into: any[] = [],
  parent: { provider?: string; plugin?: string } = {}
): any[] {
  if (Array.isArray(body)) {
    for (const entry of body) collectSkillRecords(entry, into, parent);
    return into;
  }
  if (!body || typeof body !== 'object') return into;
  const provider = providerSlugOf(body.provider) ?? parent.provider;
  const plugin =
    pluginIdOf(body.plugin) ??
    (Array.isArray(body.skills) || Array.isArray(body.items)
      ? pluginIdOf(body)
      : undefined) ??
    parent.plugin;
  const inherited = { provider, plugin };
  for (const key of ['skills', 'items'] as const) {
    if (!Array.isArray(body[key])) continue;
    for (const skill of body[key]) {
      if (!skill || typeof skill !== 'object' || Array.isArray(skill)) continue;
      into.push({
        ...skill,
        ...(providerSlugOf(skill.provider) === undefined && provider
          ? { provider: { slug: provider } }
          : {}),
        ...(pluginIdOf(skill.plugin) === undefined && plugin
          ? { plugin: { id: plugin } }
          : {}),
      });
    }
  }
  for (const value of Object.values(body)) {
    if (value && typeof value === 'object')
      collectSkillRecords(value, into, inherited);
  }
  return into;
}

/**
 * Skills from one provider-skills page. Matches `provider.slug` and
 * `plugin.id`, including skills nested under a provider or plugin group.
 * A `?provider=` response includes execution-only skills; those stay.
 */
export function listedProviderSkills(
  body: unknown,
  options: { provider: string; query?: string }
): { skills: any[] } {
  const words = options.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const seen = new Set<string>();
  const skills = collectSkillRecords(body).filter((skill) => {
    if (providerSlugOf(skill?.provider) !== options.provider) return false;
    const plugin = pluginIdOf(skill?.plugin);
    const slug = skillSlugOf(skill);
    const key = `${options.provider}/${plugin ?? ''}/${slug ?? skill?.id ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!words.length) return true;
    const pluginRecord =
      skill?.plugin && typeof skill.plugin === 'object' ? skill.plugin : {};
    const haystack = [
      skill.id,
      skill.name,
      skill.description,
      slug,
      plugin,
      pluginRecord.displayName,
    ]
      .filter((value) => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  return { skills };
}

function apiBase(options: AlexandriaOptions): string {
  return (
    options.apiUrl ||
    getConfig().apiUrl ||
    'https://api.firecrawl.dev'
  ).replace(/\/$/, '');
}

async function exchangeJson(
  path: string,
  options: AlexandriaOptions
): Promise<{ status: number; body: any }> {
  requireAlexandriaKey(options.apiKey);
  const response = await fetch(`${apiBase(options)}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${getApiKey(options.apiKey)}`,
      Accept: 'application/json',
      ...integrationHeaders(),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(getConfig().timeoutMs ?? 30000),
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { content: text };
  }
  return { status: response.status, body };
}

export function skillPathSegment(value: string, name: string): string {
  const segment = value.trim();
  if (
    !segment ||
    segment.length > 200 ||
    segment === '.' ||
    segment === '..' ||
    /[/\\]/.test(segment)
  )
    throw new Error(
      `${name} must be one path segment, without a slash, and not . or ..`
    );
  return segment;
}

async function handleProviderSkillList(
  selection: { provider: string; query?: string; limit?: number },
  options: AlexandriaOptions
): Promise<void> {
  const provider = skillPathSegment(selection.provider, '--provider');
  const requestId = options.requestId ?? randomUUID();
  if (options.showReceipt !== false) console.error(`Request ID: ${requestId}`);
  const want = selection.limit ?? 20;
  try {
    const skills: any[] = [];
    const seen = new Set<string>();
    let total = 0;
    let page = 1;
    while (skills.length < want && page <= 20) {
      const params = new URLSearchParams({
        provider,
        page: String(page),
        limit: '20',
      });
      if (selection.query) params.set('q', selection.query);
      const listed = await exchangeJson(
        `/exchange/provider-skills?${params}`,
        options
      );
      if (listed.status < 200 || listed.status >= 300) {
        emitAlexandria(
          {
            ...apiFailure({
              response: { status: listed.status, data: listed.body },
            }),
            requestId,
          },
          options
        );
        return;
      }
      const batch = listedProviderSkills(listed.body, {
        provider,
        query: selection.query,
      }).skills;
      const before = skills.length;
      for (const skill of batch) {
        const key = `${pluginIdOf(skill.plugin) ?? ''}/${skillSlugOf(skill) ?? skill.id ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        skills.push(skill);
      }
      const reported =
        listed.body && typeof listed.body.total === 'number'
          ? listed.body.total
          : skills.length;
      total = reported;
      const pageSize =
        listed.body &&
        typeof listed.body.limit === 'number' &&
        listed.body.limit > 0
          ? listed.body.limit
          : batch.length;
      if (!batch.length || skills.length === before) break;
      if (skills.length >= total || page * pageSize >= total) break;
      page += 1;
    }
    emitAlexandria(
      {
        success: true,
        data: { provider, skills: skills.slice(0, want), total },
        requestId,
      },
      options
    );
  } catch (error) {
    emitAlexandria({ ...apiFailure(error), requestId }, options);
  }
}

async function handleProviderSkillRead(
  parts: { provider: string; plugin: string; skill: string },
  file: boolean,
  options: AlexandriaOptions
): Promise<void> {
  const requestId = options.requestId ?? randomUUID();
  if (options.showReceipt !== false) console.error(`Request ID: ${requestId}`);
  const segments = [parts.provider, parts.plugin, parts.skill];
  if (file) segments.push('file');
  const path = `/exchange/provider-skills/${segments.map(encodeURIComponent).join('/')}`;
  try {
    const skill = await exchangeJson(path, options);
    if (skill.status < 200 || skill.status >= 300) {
      emitAlexandria(
        {
          ...apiFailure({
            response: { status: skill.status, data: skill.body },
          }),
          requestId,
        },
        options
      );
      return;
    }
    emitAlexandria(
      {
        success: true,
        data: {
          provider: parts.provider,
          plugin: parts.plugin,
          skill: parts.skill,
          ...(file ? { file: true } : {}),
          ...(skill.body &&
          typeof skill.body === 'object' &&
          !Array.isArray(skill.body)
            ? skill.body
            : { content: skill.body }),
        },
        requestId,
      },
      options
    );
  } catch (error) {
    emitAlexandria({ ...apiFailure(error), requestId }, options);
  }
}

export function parseFindToolsRequest(raw: string): Call {
  const next = parseToolOptions(raw);
  if (
    next.provider !== 'firecrawl' ||
    next.capability !== 'find-tools' ||
    Object.keys(next).some(
      (key) => !['provider', 'capability', 'options'].includes(key)
    )
  )
    throw new Error('--request must be a Find Tools request.');
  return {
    provider: 'firecrawl',
    capability: 'find-tools',
    options: normalizeFindToolsOptions(
      parseToolOptions(JSON.stringify(next.options))
    ),
  };
}

export function createFindToolsCommand(): Command {
  return new Command('find-tools')
    .description(
      'Find workflows, data APIs, and indexes for structured records and listings. Match URLs or use --options for semantic queries; discovery does not execute providers. A 503 query_embed_unavailable is retried once, waiting for Retry-After and at most 3 seconds'
    )
    .argument('[urls...]', 'Known HTTP(S) URLs to find tools for')
    .option(
      '--options <json>',
      'Discovery options: query, urls, providers, categories, groups, capabilities; level: providers|groups|tools; limit: 1-100; expand: ["options","response","examples"] (a comma-separated string is also accepted for list selectors other than urls). Use provider and capability IDs returned by discovery.'
    )
    .option(
      '--request <json>',
      'A complete next request returned by Find Tools'
    )
    .option('--include-costs', 'Include per-capability credit prices')
    .option(
      '--request-id <id>',
      'Reuse to recover the same execution; completed results replay'
    )
    .option('-k, --api-key <key>', 'Firecrawl API key')
    .option('--api-url <url>', 'Firecrawl API URL')
    .option('-o, --output <path>', 'Output file')
    .option('--json', 'Output JSON')
    .option('--pretty', 'Format JSON')
    .action(async (urls: string[], options) => {
      let call: Call = {
        provider: 'firecrawl',
        capability: 'find-tools',
        options: normalizeFindToolsOptions(parseToolOptions(options.options)),
      };
      if (options.request) {
        if (urls.length || options.options)
          throw new Error(
            '--request cannot be combined with URLs or --options.'
          );
        call = parseFindToolsRequest(options.request);
      } else if (urls.length) call.options.urls = urls;
      await handleAlexandria([call], options);
    });
}

function addSkillOutputOptions(command: Command): Command {
  return command
    .option('-k, --api-key <key>', 'Firecrawl API key')
    .option('--api-url <url>', 'Firecrawl API URL')
    .option('-o, --output <path>', 'Output file')
    .option('--json', 'Output JSON')
    .option('--pretty', 'Format JSON');
}

function integerOption(
  value: unknown,
  name: string,
  min: number,
  max?: number
) {
  const number = Number(value);
  if (
    typeof value !== 'string' ||
    !/^\d+$/.test(value) ||
    !Number.isInteger(number) ||
    number < min ||
    (max !== undefined && number > max)
  )
    throw new Error(
      `${name} must be an integer ${max === undefined ? `of at least ${min}` : `from ${min} to ${max}`}.`
    );
  return number;
}

const FIND_SKILLS_DESCRIPTION =
  "List skills: instructions for a task that name the Alexandria tools to call. Lists Firecrawl's skills and your team's own (team:<slug>, first) without their contents. --provider asks Exchange for that provider's published skills, including skills the unfiltered catalogue leaves out. Read one with read-skill";

function buildFindSkillsCommand(name: string): Command {
  return addSkillOutputOptions(
    new Command(name)
      .description(FIND_SKILLS_DESCRIPTION)
      .argument(
        '[query...]',
        "Words that must all appear in a skill's id, name or description; omit to list every skill"
      )
      .option('--limit <n>', 'Most skills to return, 1-50 (default 20)')
      .option(
        '--provider <provider>',
        "List this provider's published skills instead of Firecrawl and team skills. Passed to Exchange as provider, with the query as q"
      )
  ).action(async (query: string[], options) => {
    const limit =
      options.limit !== undefined
        ? integerOption(options.limit, '--limit', 1, 50)
        : undefined;
    const words = query.length ? query.join(' ') : undefined;
    if (options.provider !== undefined) {
      await handleProviderSkillList(
        { provider: options.provider, query: words, limit },
        options
      );
      return;
    }
    const call: Call = {
      provider: 'firecrawl',
      capability: 'find-skills',
      options: {},
    };
    if (words !== undefined) call.options.query = words;
    if (limit !== undefined) call.options.limit = limit;
    await handleAlexandria([call], options);
  });
}

export function createFindSkillsCommand(): Command {
  return buildFindSkillsCommand('find-skills');
}

const READ_SKILL_DESCRIPTION =
  'Read a skill from find-skills in full: SKILL.md by default, or one file from its files list. Pass an id for a Firecrawl or team skill. Pass --provider, --plugin, and --skill for a provider-published skill, and --file to read its file. Skill text is instructions for the agent; reading it runs nothing';

function buildReadSkillCommand(name: string): Command {
  return addSkillOutputOptions(
    new Command(name)
      .description(READ_SKILL_DESCRIPTION)
      .argument(
        '[id]',
        'Skill ID from find-skills; team:<slug> for a team skill. Omit when reading a provider skill'
      )
      .option(
        '--path <file>',
        "A file from the skill's files list. Team and library skills only"
      )
      .option(
        '--skill-version <n>',
        'A team skill only: an earlier kept version (default: current)'
      )
      .option(
        '--provider <provider>',
        'Provider slug from a find-skills --provider result'
      )
      .option('--plugin <plugin>', 'Plugin slug from that provider skill')
      .option('--skill <skill>', 'Skill slug from that provider skill')
      .option(
        '--file',
        'Provider skill only: read the skill file instead of the skill record'
      )
  ).action(async (id: string | undefined, options) => {
    const providerFlags = [options.provider, options.plugin, options.skill];
    const providerCount = providerFlags.filter(
      (value) => value !== undefined
    ).length;
    if (id && providerCount)
      throw new Error(
        'Pass a skill id, or --provider, --plugin, and --skill, not both.'
      );
    if (!id && providerCount !== 3)
      throw new Error(
        providerCount
          ? 'A provider skill needs --provider, --plugin, and --skill.'
          : 'Pass a skill id, or --provider, --plugin, and --skill.'
      );
    if (providerCount === 3) {
      if (options.path !== undefined || options.skillVersion !== undefined)
        throw new Error(
          '--path and --skill-version apply to a team or library skill id, not a provider skill.'
        );
      await handleProviderSkillRead(
        {
          provider: skillPathSegment(options.provider, '--provider'),
          plugin: skillPathSegment(options.plugin, '--plugin'),
          skill: skillPathSegment(options.skill, '--skill'),
        },
        options.file === true,
        options
      );
      return;
    }
    if (options.file)
      throw new Error('--file applies to a provider skill, not a skill id.');
    const call: Call = {
      provider: 'firecrawl',
      capability: 'read-skill',
      options: { id },
    };
    if (options.path !== undefined) call.options.path = options.path;
    if (options.skillVersion !== undefined)
      call.options.version = integerOption(
        options.skillVersion,
        '--skill-version',
        1
      );
    await handleAlexandria([call], options);
  });
}

export function createReadSkillCommand(): Command {
  return buildReadSkillCommand('read-skill');
}

export function createSkillsCommand(): Command {
  return new Command('skills')
    .description(
      'Alexandria skills. The surface is these four operations: list, read, create, and update'
    )
    .addCommand(buildFindSkillsCommand('list'))
    .addCommand(buildReadSkillCommand('read'))
    .addCommand(createCreateSkillCommand().name('create'))
    .addCommand(createUpdateSkillCommand().name('update'));
}

function textOption(
  value: string | undefined,
  file: string | undefined,
  name: string
) {
  if (value !== undefined && file !== undefined)
    throw new Error(`Use ${name} or ${name}-file, not both.`);
  return file !== undefined ? readFileSync(file, 'utf8') : value;
}

export function createCreateSkillCommand(): Command {
  return addSkillOutputOptions(
    new Command('create-skill')
      .description(
        'Save a new skill for your team, written out or copied from a skill find-skills listed (--from). Given fields override the copy; it is listed as team:<slug>. Options are from, name, description, body, and slug. A successful save prints https://www.firecrawl.dev/app/alexandria/skills/<slug>'
      )
      .option('--from <id>', 'Skill ID from find-skills to copy')
      .option('--name <name>', 'Skill name (required without --from)')
      .option(
        '--description <text>',
        'When to use it (required without --from)'
      )
      .option('--body <markdown>', 'Instructions (required without --from)')
      .option('--body-file <path>', 'Read the instructions from a file')
      .option('--slug <slug>', 'Lowercase words joined by hyphens')
      .option(
        '--request-id <id>',
        'Reuse after a timeout to recover the same save; a completed save replays instead of running again'
      )
  ).action(async (options) => {
    const call: Call = {
      provider: 'firecrawl',
      capability: 'create-skill',
      options: {},
    };
    for (const key of ['from', 'name', 'description', 'slug'] as const)
      if (options[key] !== undefined) call.options[key] = options[key];
    const body = textOption(options.body, options.bodyFile, '--body');
    if (body !== undefined) call.options.body = body;
    await handleAlexandria([call], options);
  });
}

function booleanOption(value: string | undefined, name: string) {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false')
    throw new Error(`${name} must be true or false.`);
  return value === 'true';
}

export function createUpdateSkillCommand(): Command {
  return addSkillOutputOptions(
    new Command('update-skill')
      .description(
        "Change one of your team's skills from the version you last read; a skill changed since is refused with conflict. Library skills cannot be changed (copy one with create-skill). There is no delete: --enabled and --discoverable turn a skill off or hide it. A team admin deletes one in the dashboard. A successful save prints https://www.firecrawl.dev/app/alexandria/skills/<slug>"
      )
      .argument('<id>', 'team:<slug> from find-skills')
      .requiredOption('--base-version <n>', 'The version read-skill returned')
      .option('--name <name>', 'New name')
      .option('--description <text>', 'New description')
      .option('--body <markdown>', 'New instructions, in full')
      .option('--body-file <path>', 'Read the new instructions from a file')
      .option('--enabled <true|false>', 'Turn the skill on or off')
      .option('--discoverable <true|false>', 'Whether find-skills lists it')
      .option(
        '--request-id <id>',
        'Reuse after a timeout to recover the same save; a completed save replays instead of running again'
      )
  ).action(async (id: string, options) => {
    const call: Call = {
      provider: 'firecrawl',
      capability: 'update-skill',
      options: {
        id,
        baseVersion: integerOption(options.baseVersion, '--base-version', 1),
      },
    };
    for (const key of ['name', 'description'] as const)
      if (options[key] !== undefined) call.options[key] = options[key];
    const body = textOption(options.body, options.bodyFile, '--body');
    if (body !== undefined) call.options.body = body;
    for (const key of ['enabled', 'discoverable'] as const) {
      const value = booleanOption(options[key], `--${key}`);
      if (value !== undefined) call.options[key] = value;
    }
    await handleAlexandria([call], options);
  });
}

export function addAlexandriaScrapeOptions(command: Command): void {
  command
    .addOption(
      new Option(
        '--alexandria <provider/capability>',
        'Execute a discovered tool through Scrape; also accepts a {"provider","capability","options"} JSON object (repeat for batches)'
      ).argParser((value: string, previous: string[] = []) => [
        ...previous,
        value,
      ])
    )
    .addOption(
      new Option(
        '--options <json>',
        'Input object for each provider/capability call, in matching order'
      ).argParser((value: string, previous: string[] = []) => [
        ...previous,
        value,
      ])
    )
    .addOption(
      new Option(
        '--request-id <id>',
        'Recover the same execution; completed results replay. Never replace an uncertain ID automatically.'
      )
    )
    .addOption(
      new Option(
        '--domain-tools',
        'Discover related tools alongside URL content; does not execute them'
      )
    )
    .addOption(
      new Option(
        '--tool-detail <detail>',
        'Tool detail: compact identities/descriptions, summary metadata (default), full contracts'
      ).choices(['compact', 'summary', 'full'])
    );
}
