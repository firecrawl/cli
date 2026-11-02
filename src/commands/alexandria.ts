import { readFileSync } from 'node:fs';
import { receiptFor, printReceipt, printRetry } from '../utils/receipt';
import { randomUUID } from 'node:crypto';
import { Command, Option } from 'commander';
import { type AlexandriaCall } from 'firecrawl';
import { getClient } from '../utils/client';
import { getApiKey, getConfig } from '../utils/config';
import { integrationHeaders } from '../utils/integration';
import { writeOutput } from '../utils/output';
import { withoutResultPrices } from '../utils/alexandria-prices';
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
  return {
    ...(options.includeCosts ? envelope : withoutResultPrices(envelope)),
    requestId,
    receipt,
  };
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
  const shared = sharedSkillLine(envelope);
  if (shared) console.error(shared);
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
  const envelope = await requestAlexandria(calls, options);
  if (
    envelope.success &&
    calls.length === 1 &&
    calls[0].provider === 'firecrawl' &&
    calls[0].capability === 'find-skills'
  ) {
    const results = Array.isArray(envelope.data?.alexandria)
      ? envelope.data.alexandria
      : [];
    let entry =
      results.find(
        (item: any) =>
          item?.provider === 'firecrawl' && item?.capability === 'find-skills'
      ) ?? results[0];
    if (!entry) {
      entry = {
        provider: 'firecrawl',
        capability: 'find-skills',
        data: {},
      };
      envelope.data = { ...(envelope.data ?? {}), alexandria: [entry] };
    }
    await attachProviderSkills(entry, calls[0].options, options);
  }
  emitAlexandria(envelope, options);
}

export type ProviderSkillSummary = {
  id: string;
  name?: string;
  description?: string;
  source: 'provider';
  provider: string;
  plugin: string;
  skill: string;
  files?: string[];
};

/** `provider:<provider>/<plugin>/<skill>` or the same path without the prefix. */
export function parseProviderSkillId(
  id: string
): { provider: string; plugin: string; skill: string } | undefined {
  const match = /^(?:provider:)?([^/:]+)\/([^/:]+)\/([^/:]+)$/.exec(id.trim());
  if (!match) return undefined;
  const [, provider, plugin, skill] = match;
  if (!provider || !plugin || !skill) return undefined;
  return { provider, plugin, skill };
}

export function providerSkillId(
  provider: string,
  plugin: string,
  skill: string
): string {
  return `provider:${provider}/${plugin}/${skill}`;
}

export function isExecutionOnlySkill(skill: any): boolean {
  if (!skill || typeof skill !== 'object') return false;
  if (skill.executionOnly === true || skill.execution_only === true)
    return true;
  return [skill.kind, skill.mode, skill.purpose].some((value) => {
    if (typeof value !== 'string') return false;
    const normalized = value.toLowerCase().replace(/_/g, '-').trim();
    return normalized === 'execution' || normalized === 'execution-only';
  });
}

function skillText(skill: any, key: string): string | undefined {
  const value = skill?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function providerSkillFromRecord(skill: any): ProviderSkillSummary | undefined {
  if (!skill || typeof skill !== 'object' || isExecutionOnlySkill(skill))
    return undefined;
  const parsed =
    typeof skill.id === 'string' ? parseProviderSkillId(skill.id) : undefined;
  const provider = skillText(skill, 'provider') ?? parsed?.provider;
  const plugin =
    skillText(skill, 'plugin') ??
    skillText(skill, 'pluginId') ??
    skillText(skill, 'pluginSlug') ??
    parsed?.plugin;
  const name =
    skillText(skill, 'skill') ??
    skillText(skill, 'slug') ??
    parsed?.skill ??
    skillText(skill, 'name');
  if (!provider || !plugin || !name) return undefined;
  const skillId = skillText(skill, 'skill') ?? skillText(skill, 'slug') ?? name;
  if (!skillId || skillId.includes('/')) return undefined;
  const files = Array.isArray(skill.files)
    ? skill.files.filter((file: unknown) => typeof file === 'string')
    : undefined;
  return {
    id:
      typeof skill.id === 'string' && skill.id.startsWith('provider:')
        ? skill.id
        : providerSkillId(provider, plugin, skillId),
    ...(skillText(skill, 'name') ? { name: skillText(skill, 'name') } : {}),
    ...(skillText(skill, 'description')
      ? { description: skillText(skill, 'description') }
      : {}),
    source: 'provider',
    provider,
    plugin,
    skill: skillId,
    ...(files ? { files } : {}),
  };
}

function collectSkillRecords(body: any): any[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const records: any[] = [];
  for (const key of ['skills', 'items', 'results', 'providerSkills']) {
    if (Array.isArray(body[key])) records.push(...body[key]);
  }
  const groups = body.plugins ?? body.providers;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const nested = group.skills ?? group.items;
      if (!Array.isArray(nested)) continue;
      for (const skill of nested) {
        records.push({
          provider: group.provider,
          plugin: group.plugin ?? group.pluginId ?? group.slug ?? group.id,
          ...skill,
        });
      }
    }
  }
  return records;
}

export function visibleProviderSkills(
  body: unknown,
  query?: string
): ProviderSkillSummary[] {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const skills: ProviderSkillSummary[] = [];
  for (const record of collectSkillRecords(body)) {
    const skill = providerSkillFromRecord(record);
    if (!skill || seen.has(skill.id)) continue;
    const haystack =
      `${skill.id} ${skill.name ?? ''} ${skill.description ?? ''}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) continue;
    seen.add(skill.id);
    skills.push(skill);
  }
  return skills;
}

export function mergeProviderSkills(
  page: any,
  skills: ProviderSkillSummary[],
  limit?: number
): any {
  if (!page || typeof page !== 'object' || Array.isArray(page)) return page;
  const existing = (Array.isArray(page.skills) ? page.skills : []).filter(
    (skill: any) => !isExecutionOnlySkill(skill)
  );
  const seen = new Set(
    existing
      .map((skill: any) => (typeof skill?.id === 'string' ? skill.id : ''))
      .filter(Boolean)
  );
  const incoming = skills.filter((skill) => !seen.has(skill.id));
  const isTeam = (skill: any) =>
    skill?.source === 'team' ||
    (typeof skill?.id === 'string' && skill.id.startsWith('team:'));
  let merged = [
    ...existing.filter(isTeam),
    ...incoming,
    ...existing.filter((skill: any) => !isTeam(skill)),
  ];
  if (limit !== undefined) merged = merged.slice(0, limit);
  return { ...page, skills: merged, total: merged.length };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function sharedSkillLine(
  envelope: Record<string, any>
): string | undefined {
  const entry = envelope?.data?.alexandria?.[0];
  if (
    entry?.capability !== 'create-skill' &&
    entry?.capability !== 'update-skill'
  )
    return undefined;
  const pools = [
    entry.data,
    entry.data?.skill,
    entry.data?.share,
    entry.data?.sharing,
  ];
  let publicId: string | undefined;
  let link: string | undefined;
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object') continue;
    publicId ??=
      stringField(pool.publicId) ??
      stringField(pool.public_id) ??
      stringField(pool.publicID);
    for (const key of [
      'url',
      'link',
      'shareUrl',
      'sharedUrl',
      'publicUrl',
      'href',
    ]) {
      const value = stringField(pool[key]);
      if (value && /^https?:\/\//.test(value)) link ??= value;
    }
  }
  if (!publicId && !link) return undefined;
  if (link && publicId) return `Shared skill: ${link} (${publicId})`;
  return `Shared skill: ${link ?? publicId}`;
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

async function attachProviderSkills(
  entry: any,
  skillOptions: Record<string, unknown>,
  options: AlexandriaOptions
): Promise<void> {
  if (!entry || entry.error) return;
  const query =
    typeof skillOptions.query === 'string' ? skillOptions.query : undefined;
  const limit =
    typeof skillOptions.limit === 'number' ? skillOptions.limit : undefined;
  try {
    const listed = await exchangeJson('/exchange/provider-skills', options);
    if (listed.status < 200 || listed.status >= 300) {
      entry.data = {
        ...(entry.data ?? {}),
        providerSkillsError:
          typeof listed.body?.error === 'string'
            ? listed.body.error
            : `Provider skills are unavailable (HTTP ${listed.status}).`,
      };
      return;
    }
    const skills = visibleProviderSkills(listed.body, query);
    entry.data = mergeProviderSkills(entry.data ?? {}, skills, limit);
  } catch {
    entry.data = {
      ...(entry.data ?? {}),
      providerSkillsError: 'Provider skills could not be listed.',
    };
  }
}

async function handleProviderSkillRead(
  id: string,
  parts: { provider: string; plugin: string; skill: string },
  options: AlexandriaOptions & { path?: string }
): Promise<void> {
  const requestId = options.requestId ?? randomUUID();
  if (options.showReceipt !== false) console.error(`Request ID: ${requestId}`);
  const encoded = [parts.provider, parts.plugin, parts.skill]
    .map(encodeURIComponent)
    .join('/');
  const skillPath = `/exchange/provider-skills/${encoded}`;
  const filePath =
    options.path !== undefined
      ? `${skillPath}/file?path=${encodeURIComponent(options.path)}`
      : undefined;
  try {
    const skill = await exchangeJson(filePath ?? skillPath, options);
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
    let data = skill.body;
    if (
      filePath === undefined &&
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      !['content', 'body', 'markdown', 'text'].some(
        (key) => typeof data[key] === 'string'
      )
    ) {
      const file = await exchangeJson(`${skillPath}/file`, options);
      if (file.status >= 200 && file.status < 300) {
        const content =
          typeof file.body === 'string'
            ? file.body
            : typeof file.body?.content === 'string'
              ? file.body.content
              : undefined;
        if (content !== undefined)
          data = { ...data, path: data.path ?? 'SKILL.md', content };
      }
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      data = {
        id,
        source: 'provider',
        provider: parts.provider,
        plugin: parts.plugin,
        skill: parts.skill,
        ...data,
      };
    }
    emitAlexandria(
      {
        success: true,
        data: {
          alexandria: [
            {
              provider: 'firecrawl',
              capability: 'read-skill',
              data,
            },
          ],
        },
        requestId,
      },
      options
    );
  } catch (error) {
    emitAlexandria(
      {
        ...apiFailure(error),
        requestId,
      },
      options
    );
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

export function createFindSkillsCommand(): Command {
  return addSkillOutputOptions(
    new Command('find-skills')
      .description(
        "Find skills: instructions for a task that name the Alexandria tools to call. Lists Firecrawl's skills, your team's own (team:<slug>, first), and provider-published skills (provider:<provider>/<plugin>/<skill>) without their contents. Execution-only skills are omitted. Read one with read-skill"
      )
      .argument(
        '[query...]',
        "Words that must all appear in a skill's id, name or description; omit to list every skill"
      )
      .option('--limit <n>', 'Most skills to return, 1-50 (default 20)')
  ).action(async (query: string[], options) => {
    const call: Call = {
      provider: 'firecrawl',
      capability: 'find-skills',
      options: {},
    };
    if (query.length) call.options.query = query.join(' ');
    if (options.limit !== undefined)
      call.options.limit = integerOption(options.limit, '--limit', 1, 50);
    await handleAlexandria([call], options);
  });
}

export function createReadSkillCommand(): Command {
  return addSkillOutputOptions(
    new Command('read-skill')
      .description(
        'Read a skill from find-skills in full: SKILL.md by default, or one file from its files list. Skill text is instructions for the agent; reading it runs nothing. Provider skills use provider:<provider>/<plugin>/<skill>'
      )
      .argument(
        '<id>',
        'Skill ID from find-skills; team:<slug> for a team skill; provider:<provider>/<plugin>/<skill> for a provider skill'
      )
      .option('--path <file>', "A file from the skill's files list")
      .option(
        '--skill-version <n>',
        'A team skill only: an earlier kept version (default: current)'
      )
  ).action(async (id: string, options) => {
    const providerSkill = parseProviderSkillId(id);
    if (providerSkill && id.trim().startsWith('provider:')) {
      await handleProviderSkillRead(id.trim(), providerSkill, options);
      return;
    }
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
        'Save a new skill for your team, written out or copied from a skill find-skills listed (--from). Given fields override the copy; it is listed as team:<slug>. --shared true publishes a public id and link'
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
        '--shared <true|false>',
        'Share the new skill (true) or keep it in the team (false). true prints the public id or link'
      )
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
    const shared = booleanOption(options.shared, '--shared');
    if (shared !== undefined) call.options.shared = shared;
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
        "Change one of your team's skills from the version you last read; a skill changed since is refused with conflict. Library skills cannot be changed (copy one with create-skill); there is no delete"
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
        '--shared <true|false>',
        'Share the skill with a public id and link, or turn sharing off. true prints the public id or link'
      )
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
    for (const key of ['enabled', 'discoverable', 'shared'] as const) {
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
