import { receiptFor, printReceipt, printRetry } from '../utils/receipt';
import { randomUUID } from 'node:crypto';
import { Command, Option } from 'commander';
import { type AlexandriaCall } from 'firecrawl';
import { getClient } from '../utils/client';
import { getApiKey } from '../utils/config';
import { writeOutput } from '../utils/output';

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
    const slash = address.indexOf('/');
    if (slash < 1 || slash === address.length - 1)
      throw new Error('Use a provider/capability address.');
    return {
      provider: address.slice(0, slash),
      capability: address.slice(slash + 1),
      options: parseToolOptions(values[i]),
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
  return { ...envelope, requestId, receipt };
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
    envelope.guidance =
      'Review the provider terms with firecrawl alexandria terms show <provider>. Present the terms to the user and wait for explicit approval. Only then accept with firecrawl alexandria terms accept <provider> --terms-version <version> --digest <sha256> --confirm. If the API-provided link is unavailable, use https://www.firecrawl.dev/app/settings?tab=data-sources. Do not automatically retry or accept.';
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
    options: parseToolOptions(JSON.stringify(next.options)),
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
      'Discovery options: query, urls, providers, categories, groups, capabilities; level: providers|groups|tools; limit: 1-100; expand: options,response,examples. Use provider and capability IDs returned by discovery.'
    )
    .option(
      '--request <json>',
      'A complete next request returned by Find Tools'
    )
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
        options: parseToolOptions(options.options),
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

export function addAlexandriaScrapeOptions(command: Command): void {
  command
    .addOption(
      new Option(
        '--alexandria <provider/capability>',
        'Execute a discovered tool through Scrape (repeat for batches)'
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
