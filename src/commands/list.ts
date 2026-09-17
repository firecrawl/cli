import { createTermsCommand } from './terms';
import { Command, InvalidArgumentError } from 'commander';
import { randomUUID } from 'node:crypto';
import {
  apiFailure,
  parseFindToolsRequest,
  requestAlexandria,
  requireAlexandriaKey,
  type AlexandriaOptions,
} from './alexandria';
import { writeOutput } from '../utils/output';
import { getApiKey, getConfig } from '../utils/config';

type Selectors = Record<string, unknown>;
type ListOptions = AlexandriaOptions & {
  category?: boolean;
  contracts?: boolean;
  limit?: number;
  request?: string;
  providers?: boolean;
};
const CATEGORY_NAMES: Record<string, string> = {
  software: 'Developer',
  government: 'Public records',
  shopping: 'Retail',
  restaurants: 'Restaurant',
  companies: 'Company',
  skills: 'Tools',
};
function categoryId(id: string): string {
  const normalized = id.trim().toLowerCase().replace(/\s+/g, '-');
  return (
    Object.entries(CATEGORY_NAMES).find(
      ([, name]) => name.toLowerCase().replaceAll(' ', '-') === normalized
    )?.[0] ?? normalized
  );
}

type Category = {
  id: string;
  name: string;
  description: string;
  nextCommand: string;
};
type Item = {
  id: string;
  provider: string;
  name?: string;
  description?: string;
  attribution?: string;
  capability?: string;
  toolCount?: number;
  creditsCost?: number;
  perRecord?: boolean;
  options?: unknown;
  requiresOneOf?: unknown;
  response?: unknown;
  example?: unknown;
  next?: unknown;
  nextCommand?: string;
};
type Page = {
  level: 'providers' | 'groups' | 'tools';
  items: Item[];
  total: number;
  next?: unknown;
  nextCommand?: string;
};

class DiscoveryFailure extends Error {
  constructor(readonly envelope: Record<string, any>) {
    super(envelope.error ?? 'Tool discovery failed.');
  }
}

function quote(value: string): string {
  return /^[a-zA-Z0-9_./:-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

async function requestCategories(
  options: ListOptions
): Promise<Record<string, any>> {
  requireAlexandriaKey(options.apiKey);
  const requestId = randomUUID();
  console.error(`Request ID: ${requestId}`);
  const base = (
    options.apiUrl ||
    getConfig().apiUrl ||
    'https://api.firecrawl.dev'
  ).replace(/\/$/, '');
  try {
    const response = await fetch(`${base}/exchange/discover`, {
      headers: {
        Authorization: `Bearer ${getApiKey(options.apiKey)}`,
        'X-Request-ID': requestId,
      },
      signal: AbortSignal.timeout(getConfig().timeoutMs ?? 30000),
      redirect: 'error',
    });
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) {
      return {
        ...apiFailure({
          response: {
            data: {
              ...body,
              error:
                body?.error ||
                `Category discovery failed (HTTP ${response.status}).`,
            },
          },
        }),
        requestId,
      };
    }
    if (
      !Array.isArray(body?.cohorts) ||
      body.cohorts.some(
        (row: any) =>
          !row ||
          typeof row.cohort !== 'string' ||
          !row.cohort.trim() ||
          typeof row.about !== 'string' ||
          !Number.isInteger(row.providers) ||
          row.providers < 0
      )
    )
      throw new Error('Discovery returned an invalid category index.');
    const items: Category[] = body.cohorts
      .map((row: any) => ({
        id: row.cohort,
        name: Object.hasOwn(CATEGORY_NAMES, row.cohort)
          ? CATEGORY_NAMES[row.cohort]
          : row.cohort
              .split('-')
              .map(
                (word: string) => word.charAt(0).toUpperCase() + word.slice(1)
              )
              .join(' '),
        description: row.about,
        nextCommand: `firecrawl alexandria list ${quote(row.cohort)} --category${options.limit === undefined ? '' : ` --limit ${options.limit}`}`,
      }))
      .sort((a: Category, b: Category) => a.name.localeCompare(b.name));
    return {
      success: true,
      requestId,
      data: { level: 'categories', items, total: items.length },
    };
  } catch (error) {
    return { ...apiFailure(error), requestId };
  }
}

function renderCategories(items: Category[]): string {
  return [
    'Firecrawl Alexandria',
    'A trusted data layer for agents to access high-provenance data.',
    '',
    'Finding data',
    '  firecrawl search "<need>" --sources alexandria',
    '  Browse a category below, or jump directly to a provider.',
    '',
    'Calling it',
    '  Browse:  firecrawl alexandria <category>',
    '  Tools:   firecrawl alexandria list <provider>',
    '  Inspect: firecrawl alexandria list <provider> <capability>',
    "  Execute: firecrawl scrape --alexandria <provider>/<capability> --options '<input JSON>'",
    '  Catalog browsing is free. Check the contract and price before executing.',
    '  Use your existing Firecrawl login or FIRECRAWL_API_KEY.',
    '',
    `Categories (${items.length})`,
    ...items.map((item) => `  ${item.name} (${item.id}): ${item.description}`),
    ...(!items.length ? ['  No categories are currently visible.'] : []),
    '',
    'Developer and Research indexes have native commands:',
    '  firecrawl developer --help',
    '  firecrawl research --help',
    '',
    'All providers: firecrawl alexandria list --providers',
  ].join('\n');
}

function nextCommand(request: unknown): string {
  const call = parseFindToolsRequest(JSON.stringify(request));
  return `firecrawl list --request ${quote(JSON.stringify(call))}`;
}

function itemCommand(item: Item): string | undefined {
  if (!item.next) return undefined;
  const { options } = parseFindToolsRequest(JSON.stringify(item.next));
  const category = Array.isArray(options.categories)
    ? options.categories[0]
    : undefined;
  const only = (value: unknown, id: string | undefined) =>
    id === undefined
      ? value === undefined
      : Array.isArray(value) && value.length === 1 && value[0] === id;
  // Keep scoped and future selectors intact when a short path cannot express them.
  if (
    ![item.provider, item.capability, category].every(
      (id) =>
        id === undefined ||
        (typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(id))
    ) ||
    !only(options.providers, item.provider) ||
    !only(options.categories, category) ||
    !only(options.capabilities, item.capability) ||
    options.groups !== undefined ||
    (options.offset !== undefined && options.offset !== 0) ||
    Object.keys(options).some(
      (key) =>
        ![
          'providers',
          'categories',
          'capabilities',
          'level',
          'limit',
          'offset',
          'expand',
        ].includes(key)
    )
  )
    return nextCommand(item.next);
  const base = `firecrawl list ${category ? `${quote(category)} ` : ''}${quote(item.provider)}`;
  const flags =
    (category ? ' --category' : '') +
    (typeof options.limit === 'number' && options.limit !== 20
      ? ` --limit ${options.limit}`
      : '');
  if (item.capability) return `${base} ${quote(item.capability)}${flags}`;
  return `${base}${flags}`;
}

function render(page: Page): string {
  const lines = [
    `${page.level[0].toUpperCase() + page.level.slice(1)} (${page.items.length} of ${page.total})`,
    '',
  ];
  for (const item of page.items) {
    lines.push(`${item.id}${item.name ? `  ${item.name}` : ''}`);
    if (item.description) lines.push(`  ${item.description}`);
    if (item.toolCount !== undefined) lines.push(`  ${item.toolCount} tools`);
    if (item.creditsCost !== undefined)
      lines.push(
        `  ${item.creditsCost} credits per ${item.perRecord ? 'record' : 'call'}`
      );
    if (item.attribution) lines.push(`  ${item.attribution}`);
    for (const [label, value] of [
      ['Inputs', item.options],
      ['Required alternatives', item.requiresOneOf],
      ['Returns', item.response],
      ['Example', item.example],
    ] as const) {
      if (value !== undefined)
        lines.push(`\n  ${label}:\n${JSON.stringify(value, null, 2)}`);
    }
    if (item.nextCommand) lines.push(`  Next: ${item.nextCommand}`);
    if (item.options !== undefined && item.capability) {
      lines.push(
        `  Execute after filling the inputs: firecrawl scrape --alexandria ${quote(`${item.provider}/${item.capability}`)} --options '<input JSON>'`
      );
    }
    lines.push('');
  }
  if (!page.items.length)
    lines.push('No matching tools are visible for these selectors.', '');
  if (page.nextCommand) lines.push(`More: ${page.nextCommand}`);
  return lines.join('\n');
}

export async function handleList(
  path: string[],
  options: ListOptions
): Promise<void> {
  const asJson =
    options.json ||
    options.pretty ||
    options.output?.toLowerCase().endsWith('.json');
  const receipts: {
    requestId: string;
    scrape_id?: string;
    creditsCost?: number;
  }[] = [];
  try {
    if (
      options.request &&
      (path.length ||
        options.category ||
        options.providers ||
        options.limit !== undefined)
    )
      throw new Error(
        '--request cannot be combined with a path or list filters.'
      );
    if (path.some((part) => !part.trim() || part.length > 200))
      throw new Error('Use non-empty catalogue IDs of at most 200 characters.');
    if (options.category && !path.length)
      throw new Error('Provide a category or provider ID.');
    if (options.providers && (path.length || options.category))
      throw new Error(
        '--providers lists all providers; omit the path and other selectors.'
      );
    if (!path.length && !options.request && !options.providers) {
      const result = await requestCategories(options);
      receipts.push({ requestId: result.requestId });
      if (!result.success) throw new DiscoveryFailure(result);
      writeOutput(
        asJson
          ? JSON.stringify(
              { ...result, discoveryRequests: receipts },
              null,
              options.pretty ? 2 : undefined
            )
          : renderCategories(result.data.items),
        options.output,
        !!options.output
      );
      return;
    }
    const limit = options.limit ?? 20;

    async function fetchPage(selectors: Selectors) {
      const envelope = await requestAlexandria(
        [
          {
            provider: 'firecrawl',
            capability: 'find-tools',
            options: selectors,
          },
        ],
        options
      );
      receipts.push({
        requestId: envelope.requestId,
        scrape_id: envelope.scrape_id,
        creditsCost: envelope.data?.creditsCost,
      });
      const item = envelope.data?.alexandria?.[0];
      if (!envelope.success || item?.error)
        throw new DiscoveryFailure(envelope);
      const page = item?.data as Page | undefined;
      if (
        !page ||
        !['providers', 'groups', 'tools'].includes(page.level) ||
        !Array.isArray(page.items) ||
        !Number.isInteger(page.total) ||
        page.items.some(
          (row) =>
            !row ||
            typeof row.id !== 'string' ||
            typeof row.provider !== 'string'
        )
      )
        throw new Error('Find Tools returned an invalid catalogue response.');
      return { envelope, page };
    }

    async function resolve() {
      if (options.request)
        return fetchPage(parseFindToolsRequest(options.request).options);
      if (!path.length) return fetchPage({ level: 'providers', limit });
      if (options.contracts && options.category && path.length === 1) {
        return fetchPage({
          categories: [categoryId(path[0])],
          level: 'tools',
          expand: ['options', 'response', 'examples'],
          limit,
        });
      }
      let scope: Selectors = { providers: [path[0]] };
      let remaining = path.slice(1);
      let result = options.category
        ? undefined
        : await fetchPage({
            ...scope,
            level: remaining.length ? 'providers' : 'tools',
            limit,
          });
      if (!result?.page.total) {
        scope = { categories: [path[0]] };
        result = await fetchPage({ ...scope, level: 'providers', limit });
        if (!result.page.total && categoryId(path[0]) !== path[0]) {
          scope = { categories: [categoryId(path[0])] };
          result = await fetchPage({ ...scope, level: 'providers', limit });
        }
        if (!result.page.total || !remaining.length) return result;
        scope.providers = [remaining[0]];
        remaining = remaining.slice(1);
        if (!remaining.length)
          return fetchPage({ ...scope, level: 'tools', limit });
      }
      if (!remaining.length) return result;
      const selected = remaining.join('/');
      return fetchPage({
        ...scope,
        capabilities: [selected],
        level: 'tools',
        expand: ['options', 'response', 'examples'],
        limit,
      });
    }

    const { envelope, page } = await resolve();
    page.items = page.items.map((item) => ({
      ...item,
      nextCommand: itemCommand(item),
    }));
    if (page.next) page.nextCommand = nextCommand(page.next);
    const output = asJson
      ? JSON.stringify(
          { ...envelope, discoveryRequests: receipts },
          null,
          options.pretty ? 2 : undefined
        )
      : render(page);
    writeOutput(output, options.output, !!options.output);
  } catch (error) {
    process.exitCode = 1;
    const failure =
      error instanceof DiscoveryFailure ? error.envelope : apiFailure(error);
    const message =
      failure.error ??
      failure.data?.alexandria?.[0]?.error?.message ??
      'Tool discovery failed.';
    writeOutput(
      asJson
        ? JSON.stringify(
            { ...failure, discoveryRequests: receipts },
            null,
            options.pretty ? 2 : undefined
          )
        : `Error: ${message}`,
      options.output,
      !!options.output
    );
  }
}

export function createListCommand(name = 'list'): Command {
  const command = new Command(name);
  if (name === 'list') command.alias('list-tools');
  return command
    .description(
      'Start with the Alexandria category index, then browse providers and tool contracts; discovery only'
    )
    .argument(
      '[path...]',
      'Provider or category, optionally followed by a capability'
    )
    .option(
      '--category',
      'Treat the first ID as a category when a provider has the same ID'
    )
    .option('--contracts', 'Include full tool contracts for a category')
    .option('--providers', 'List all providers instead of the category index')
    .option(
      '--limit <number>',
      'Provider/tool results per page (1-100; default: 20); the root shows all categories',
      (raw) => {
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 100)
          throw new InvalidArgumentError('Use an integer from 1 to 100.');
        return value;
      }
    )
    .option(
      '--request <json>',
      'Follow a complete next or pagination request from Find Tools'
    )
    .option('-k, --api-key <key>', 'Firecrawl API key')
    .option('--api-url <url>', 'Firecrawl API URL')
    .option('-o, --output <path>', 'Output file')
    .option('--json', 'Output JSON with discovery receipts and next commands')
    .option('--pretty', 'Format JSON')
    .addHelpText(
      'after',
      '\nExamples:\n  firecrawl alexandria list\n  firecrawl list --providers\n  firecrawl list finance\n  firecrawl list benzinga\n  firecrawl list benzinga <capability> --json\n\nProvider IDs take precedence over categories.\nNo listed tool is executed. Search by task with firecrawl search --sources alexandria.\n'
    )
    .action(handleList);
}

export function createAlexandriaCommand(): Command {
  const browse = createListCommand('browse').action(
    (path: string[], options: ListOptions) =>
      handleList(path, {
        ...options,
        category: path.length > 0,
      })
  );
  return new Command('alexandria')
    .description(
      'Browse categories with alexandria <category>, or inspect providers with alexandria list'
    )
    .addCommand(createListCommand())
    .addCommand(createTermsCommand())
    .addCommand(browse, { isDefault: true, hidden: true });
}
