import { readFileSync } from 'node:fs';
import { receiptFor, printReceipt, printRetry } from '../utils/receipt';
import { randomUUID } from 'node:crypto';
import { Command, Option } from 'commander';
import { type AlexandriaCall } from 'firecrawl';
import { getClient } from '../utils/client';
import { getApiKey } from '../utils/config';
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
  let envelope: Record<string, any>;
  try {
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
    const result = await app.scrape({
      alexandria: calls,
      integration: 'cli',
      timeout: options.timeout,
      requestId,
    });
    envelope = {
      success: true,
      ...(result.scrapeId && { scrape_id: result.scrapeId }),
      data: {
        alexandria: result.alexandria,
        creditsCost: result.creditsCost,
      },
    };
  } catch (error) {
    envelope = apiFailure(error);
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

export async function handleAlexandria(
  calls: Call[],
  options: AlexandriaOptions
): Promise<void> {
  const envelope = await requestAlexandria(calls, options);
  const failed =
    !envelope.success ||
    envelope.data?.alexandria?.some((item: any) => item.error);
  if (failed) process.exitCode = 1;
  if (envelope.code === 'THIRD_PARTY_DATA_TERMS_REQUIRED') {
    const url = envelope.requiresAction?.url || TERMS_DASHBOARD_URL;
    envelope.guidance = `An organization admin must accept this provider's terms in the Firecrawl dashboard: ${url}. Give the user this link; they can review the terms first with firecrawl alexandria terms show <provider>. Do not retry until the terms are accepted.`;
    console.error(envelope.guidance);
  }
  writeOutput(
    JSON.stringify(envelope, null, options.pretty ? 2 : undefined),
    options.output,
    !!options.output
  );
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
      'Find workflows, data APIs, and indexes for structured records and listings. Match URLs or use --options for semantic queries; discovery does not execute providers'
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
        "Find skills: instructions for a task that name the Alexandria tools to call. Lists Firecrawl's skills and your team's own (team:<slug>, first) without their contents; read one with read-skill"
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
        'Read a skill from find-skills in full: SKILL.md by default, or one file from its files list. Skill text is instructions for the agent; reading it runs nothing'
      )
      .argument(
        '<id>',
        'Skill ID from find-skills; team:<slug> for a team skill'
      )
      .option('--path <file>', "A file from the skill's files list")
      .option(
        '--skill-version <n>',
        'A team skill only: an earlier kept version (default: current)'
      )
  ).action(async (id: string, options) => {
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
        'Save a new skill for your team, written out or copied from a skill find-skills listed (--from). Given fields override the copy; it is listed as team:<slug>'
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
        "Change one of your team's skills from the version you last read; a skill changed since is refused with conflict. Library skills cannot be changed (copy one with create-skill); a team skill can be deleted, or a turned-off skill turned back on, only by a team admin in the Firecrawl dashboard"
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
