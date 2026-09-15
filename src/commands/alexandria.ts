import { randomUUID } from 'node:crypto';
import { Command, Option } from 'commander';
import { SdkError, type AlexandriaCall } from 'firecrawl';
import { getClient } from '../utils/client';
import { getApiKey } from '../utils/config';
import { writeOutput } from '../utils/output';

type Call = AlexandriaCall & { options: Record<string, unknown> };
type Options = {
  apiKey?: string;
  apiUrl?: string;
  requestId?: string;
  timeout?: number;
  output?: string;
  json?: boolean;
  pretty?: boolean;
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

export function apiFailure(error: unknown): Record<string, unknown> {
  const body =
    (error as any)?.response?.data ??
    (error instanceof SdkError
      ? {
          error: error.message,
          code: error.code,
          chargeId: error.chargeId,
          requiresAction:
            (error.details as any)?.requiresAction ?? error.requiresAction,
        }
      : undefined);
  return {
    success: false,
    error:
      typeof body?.error === 'string'
        ? body.error
        : error instanceof Error
          ? error.message
          : 'Request failed',
    ...(typeof body?.code === 'string' && { code: body.code }),
    ...(typeof body?.chargeId === 'string' && { chargeId: body.chargeId }),
    ...(body?.requiresAction && { requiresAction: body.requiresAction }),
  };
}

export async function handleAlexandria(
  calls: Call[],
  options: Options
): Promise<void> {
  const requestId = options.requestId ?? randomUUID();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId))
    throw new Error('Invalid --request-id.');
  requireAlexandriaKey(options.apiKey);
  // Print before execution so even an interrupted request can reuse its identity.
  console.error(`Request ID: ${requestId}`);
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
  const failed =
    !envelope.success ||
    envelope.data?.alexandria?.some((item: any) => item.error);
  if (failed) process.exitCode = 1;
  writeOutput(
    JSON.stringify(
      { ...envelope, requestId },
      null,
      options.pretty ? 2 : undefined
    ),
    options.output,
    !!options.output
  );
}

export function createFindToolsCommand(): Command {
  return new Command('find-tools')
    .description(
      'Explore Alexandria providers and tool contracts without executing them'
    )
    .argument('[urls...]')
    .option('--options <json>', 'Find Tools catalogue filters')
    .option(
      '--request <json>',
      'A complete next request returned by Find Tools'
    )
    .option('--request-id <id>', 'Reuse for an identical retry')
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
        const next = parseToolOptions(options.request);
        if (
          next.provider !== call.provider ||
          next.capability !== call.capability ||
          Object.keys(next).some(
            (key) => !['provider', 'capability', 'options'].includes(key)
          )
        )
          throw new Error('--request must be a Find Tools request.');
        call.options = parseToolOptions(JSON.stringify(next.options));
      } else if (urls.length) call.options.urls = urls;
      await handleAlexandria([call], options);
    });
}

export function addAlexandriaScrapeOptions(
  command: Command,
  visible = false
): void {
  command
    .addOption(
      new Option(
        '--alexandria <provider/capability>',
        'Execute an Alexandria tool; repeat for a batch'
      )
        .argParser((value: string, previous: string[] = []) => [
          ...previous,
          value,
        ])
        .hideHelp(!visible)
    )
    .addOption(
      new Option(
        '--options <json>',
        'JSON inputs paired with each Alexandria tool'
      )
        .argParser((value: string, previous: string[] = []) => [
          ...previous,
          value,
        ])
        .hideHelp(!visible)
    )
    .addOption(
      new Option(
        '--request-id <id>',
        'Optional ID for an identical retry'
      ).hideHelp(!visible)
    )
    .addOption(
      new Option(
        '--domain-tools',
        'Include matching tool contracts with a URL scrape'
      ).hideHelp(!visible)
    );
}
