import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const requests: { url?: string; headers: Record<string, any>; body: any }[] =
  [];
let server: Server;
let baseUrl: string;
let status = 200;
let response: Record<string, any>;
let responseFor: ((body: any) => Record<string, any>) | undefined;
const home = mkdtempSync(join(tmpdir(), 'alexandria-cli-'));

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({
      url: req.url,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(responseFor?.(requests.at(-1)?.body) ?? response));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  requests.length = 0;
  status = 200;
  responseFor = undefined;
  response = {
    success: true,
    scrape_id: 'scrape-1',
    data: {
      alexandria: [{ data: { value: 42 }, creditsCost: 1 }],
      creditsCost: 1,
    },
  };
});

async function cli(args: string[], key = 'fc-test') {
  try {
    return {
      code: 0,
      ...(await exec(process.execPath, ['dist/index.js', ...args], {
        timeout: 10000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          FIRECRAWL_API_KEY: key,
          FIRECRAWL_API_URL: baseUrl,
          FIRECRAWL_NO_UPDATE_CHECK: '1',
        },
      })),
    };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return result;
  }
}

function catalogue(level: string, items: any[], next?: unknown) {
  return {
    success: true,
    scrape_id: 'discovery-1',
    data: {
      creditsCost: 0,
      alexandria: [
        {
          provider: 'firecrawl',
          capability: 'find-tools',
          creditsCost: 0,
          data: { level, items, total: items.length, next },
        },
      ],
    },
  };
}

it('starts with a live category guide and preserves category-discovery access errors', async () => {
  response = {
    cohorts: [
      {
        cohort: 'finance',
        about: 'Live market data description.',
        providers: 2,
      },
      {
        cohort: 'new-category',
        about: 'A category added by the server.',
        providers: 0,
      },
    ],
  };
  const guide = await cli(['alexandria', 'list']);
  expect(guide.code).toBe(0);
  expect(guide.stdout).toContain('Firecrawl Alexandria');
  expect(guide.stdout).toContain(
    'Finance (finance): Live market data description.'
  );
  expect(guide.stdout).toContain('New Category (new-category)');
  expect(guide.stdout).not.toContain('Providers (');
  expect(requests[0]).toMatchObject({
    url: '/exchange/discover',
    headers: { authorization: 'Bearer fc-test' },
  });
  expect(requests[0].body).toBeUndefined();
  const json = await cli(['list-tools', '--json']);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout).data).toMatchObject({
    level: 'categories',
    total: 2,
    items: [
      {
        id: 'finance',
        nextCommand: 'firecrawl alexandria list finance --category',
      },
      { id: 'new-category' },
    ],
  });
  status = 403;
  response = {
    success: false,
    error: 'Access required',
    code: 'ACCESS_REQUIRED',
    requiresAction: { type: 'request_access' },
  };
  const denied = await cli(['list', '--json']);
  expect(denied.code).toBe(1);
  expect(JSON.parse(denied.stdout)).toMatchObject({
    ...response,
    discoveryRequests: [{ requestId: expect.any(String) }],
  });
  expect(
    requests.every((request) => request.url === '/exchange/discover')
  ).toBe(true);
});

it('browses live provider IDs directly or through a category without expanding contracts', async () => {
  responseFor = (body) => {
    const options = body.alexandria[0].options;
    if (options.providers?.[0] === 'finance')
      return catalogue(options.level, []);
    if (
      ['retail', 'Retail', 'Public records'].includes(options.categories?.[0])
    )
      return catalogue(options.level, []);
    return catalogue(options.level, [
      { id: 'benzinga', provider: 'benzinga', name: 'Benzinga' },
    ]);
  };
  for (const args of [
    ['--providers'],
    ['finance'],
    ['benzinga'],
    ['finance', 'benzinga'],
  ]) {
    expect((await cli(['list', ...args])).code).toBe(0);
  }
  expect((await cli(['list-tools', 'benzinga'])).code).toBe(0);
  expect((await cli(['alexandria', 'list-tools', 'benzinga'])).code).toBe(0);
  expect((await cli(['list', 'Retail', '--category'])).code).toBe(0);
  expect((await cli(['list', 'Public records', '--category'])).code).toBe(0);
  expect(requests.map((request) => request.body.alexandria[0].options)).toEqual(
    [
      { level: 'providers', limit: 20 },
      { providers: ['finance'], level: 'tools', limit: 20 },
      { categories: ['finance'], level: 'providers', limit: 20 },
      { providers: ['benzinga'], level: 'tools', limit: 20 },
      { providers: ['finance'], level: 'providers', limit: 20 },
      { categories: ['finance'], level: 'providers', limit: 20 },
      {
        categories: ['finance'],
        providers: ['benzinga'],
        level: 'tools',
        limit: 20,
      },
      { providers: ['benzinga'], level: 'tools', limit: 20 },
      { providers: ['benzinga'], level: 'tools', limit: 20 },
      { categories: ['Retail'], level: 'providers', limit: 20 },
      { categories: ['shopping'], level: 'providers', limit: 20 },
      { categories: ['Public records'], level: 'providers', limit: 20 },
      { categories: ['government'], level: 'providers', limit: 20 },
    ]
  );
  expect(
    requests.every(
      ({ url, body }) =>
        url === '/v2/scrape' &&
        body.alexandria[0].provider === 'firecrawl' &&
        body.alexandria[0].capability === 'find-tools'
    )
  ).toBe(true);
  responseFor = () =>
    catalogue('providers', [
      { id: 'future-retailer', provider: 'future-retailer' },
    ]);
  const canonical = await cli(['list', 'retail', '--category']);
  expect(canonical.code).toBe(0);
  expect(canonical.stdout).toContain('future-retailer');
  expect(requests.at(-1)?.body.alexandria[0].options.categories).toEqual([
    'retail',
  ]);
});

it('expands only a selected tool without falling back to a group', async () => {
  responseFor = (body) => {
    const options = body.alexandria[0].options;
    if (options.capabilities?.[0] === 'calendar') return catalogue('tools', []);
    return catalogue(options.level, [
      {
        id: 'benzinga/calendar/earnings',
        provider: 'benzinga',
        capability: 'calendar/earnings',
        creditsCost: 2,
        ...(options.expand && {
          options: { date: { type: 'string' } },
          response: { type: 'object' },
        }),
      },
    ]);
  };
  const leaf = await cli(['list', 'benzinga', 'calendar/earnings']);
  expect(leaf.code).toBe(0);
  expect(leaf.stdout).toContain('Inputs:');
  expect(leaf.stdout).toContain('2 credits per call');
  expect(requests.at(-1)?.body.alexandria[0].options).toMatchObject({
    capabilities: ['calendar/earnings'],
    expand: ['options', 'response', 'examples'],
  });
  const missing = await cli(['list', 'benzinga', 'calendar']);
  expect(missing.code).toBe(0);
  expect(missing.stdout).toContain('No matching tools');
  expect(requests.at(-1)?.body.alexandria[0].options).toEqual({
    providers: ['benzinga'],
    capabilities: ['calendar'],
    expand: ['options', 'response', 'examples'],
    level: 'tools',
    limit: 20,
  });
  expect(requests).toHaveLength(4);
});

it('preserves scoped next requests, pagination and discovery receipts', async () => {
  const next = {
    provider: 'firecrawl',
    capability: 'find-tools',
    options: {
      urls: ['https://example.com'],
      providers: ['benzinga'],
      level: 'tools',
      offset: 20,
      limit: 20,
    },
  };
  response = catalogue(
    'tools',
    [
      {
        id: 'benzinga/news',
        provider: 'benzinga',
        capability: 'news',
        next,
      },
    ],
    next
  );
  const output = join(home, 'catalogue.JSON');
  const result = await cli([
    'list',
    '--request',
    JSON.stringify(next),
    '--output',
    output,
  ]);
  expect(result.code).toBe(0);
  expect(result.stderr).not.toMatch(/Request ID:|Scrape ID:|Credits:/);
  expect(requests[0].body.alexandria).toEqual([next]);
  const parsed = JSON.parse(readFileSync(output, 'utf8'));
  const page = parsed.data.alexandria[0].data;
  expect(page.nextCommand).toBe(
    `firecrawl list --request '${JSON.stringify(next)}'`
  );
  expect(page.items[0].nextCommand).toBe(page.nextCommand);
  expect(parsed.discoveryRequests).toEqual([
    {
      requestId: parsed.requestId,
      scrape_id: 'discovery-1',
      creditsCost: 0,
    },
  ]);
});

it('refuses execution through list and propagates discovery access errors', async () => {
  for (const args of [
    ['alexandria', 'list', 'benzinga', '--groups'],
    ['list', 'benzinga', 'calendar', '--group'],
  ]) {
    const removed = await cli(args);
    expect(removed.code).toBe(1);
    expect(removed.stderr).toContain('unknown option');
  }
  expect(
    (
      await cli([
        'list',
        '--request',
        '{"provider":"benzinga","capability":"news"}',
      ])
    ).code
  ).toBe(1);
  expect(
    (
      await cli([
        'list',
        'benzinga',
        '--request',
        '{"provider":"firecrawl","capability":"find-tools"}',
      ])
    ).code
  ).toBe(1);
  expect(requests).toHaveLength(0);
  response = {
    success: true,
    data: {
      alexandria: [
        {
          error: { code: 'provider_disabled', message: 'Provider is disabled' },
        },
      ],
      creditsCost: 0,
    },
  };
  const result = await cli(['list', '--providers', '--json']);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).data.alexandria[0].error).toEqual(
    response.data.alexandria[0].error
  );
  expect(JSON.parse(result.stdout).discoveryRequests).toEqual([
    {
      requestId: expect.any(String),
      creditsCost: 0,
    },
  ]);
  expect(requests).toHaveLength(1);
});

it('documents the default discovery flow and respects explicit web-only search', async () => {
  const help = await cli(['--help']);
  expect(help.stdout).toContain('find-tools');
  const searchHelp = await cli(['search', '--help']);
  expect(searchHelp.stdout).toContain('web,alexandria');
  expect(searchHelp.stdout).toContain('--no-domain-tools');
  const scrapeHelp = await cli(['scrape', '--help']);
  expect(scrapeHelp.stdout).toContain('--alexandria');
  const findHelp = await cli(['find-tools', '--help']);
  expect(findHelp.stdout).toContain('meta tool');
  const agentHelp = await cli(['agent', '--help']);
  expect(agentHelp.stdout).toContain('--thread <threadId>');
  expect(agentHelp.stdout).toContain('--mode <mode>');
  const threadHelp = await cli(['agent', 'thread', '--help']);
  expect(threadHelp.stdout).toContain('--include-data');
  response = { success: true, data: { web: [] } };
  const result = await cli([
    'search',
    'pizza hut',
    '--sources',
    'web',
    '--json',
  ]);
  expect(result.code).toBe(0);
  expect(requests[0].body).toMatchObject({
    sources: [{ type: 'web' }],
    domainTools: false,
  });
});

it('preserves mixed search results, tools and billing metadata', async () => {
  response = {
    success: true,
    id: 'search-1',
    creditsUsed: 2,
    data: {
      web: [{ url: 'https://example.com' }],
      tools: [{ provider: 'fred', capability: 'series/observations' }],
    },
  };
  const result = await cli(['search', 'pizza hut', '--json']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(response);
  expect(requests[0]).toMatchObject({
    url: '/v2/search',
    headers: { authorization: 'Bearer fc-test' },
    body: {
      sources: [{ type: 'web' }, { type: 'alexandria' }],
      domainTools: true,
    },
  });
  const readable = await cli(['search', 'pizza hut']);
  expect(readable.stdout).toContain('=== Alexandria Tools ===');
  expect(readable.stdout).toContain('series/observations');
});

it('sends provider calls to Scrape with a stable retry ID and preserves the receipt', async () => {
  const args = [
    'scrape',
    '--alexandria',
    'fred/series/observations',
    '--options',
    '{"series_id":"GDP"}',
    '--request-id',
    'retry-1',
    '--json',
  ];
  for (let i = 0; i < 2; i++) {
    const result = await cli(args);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ...response,
      requestId: 'retry-1',
      receipt: {
        creditsUsed: 1,
        requestId: 'retry-1',
        operationId: 'scrape-1',
        operationType: 'scrape',
      },
    });
  }
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toMatchObject({
    url: '/v2/scrape',
    headers: { 'x-request-id': 'retry-1' },
    body: {
      alexandria: [
        {
          provider: 'fred',
          capability: 'series/observations',
          options: { series_id: 'GDP' },
        },
      ],
    },
  });
});

it('relays terms refusals and keeps the request ID on failure', async () => {
  status = 403;
  response = {
    success: false,
    error: 'Accept provider terms',
    code: 'THIRD_PARTY_DATA_TERMS_REQUIRED',
    requiresAction: {
      type: 'accept_terms',
      terms: 'provider',
      version: '1.0',
      url: 'https://firecrawl.dev/terms/provider',
    },
  };
  const result = await cli([
    'scrape',
    '--alexandria',
    'provider/lookup',
    '--json',
  ]);
  expect(result.code).toBe(1);
  const body = JSON.parse(result.stdout);
  expect(body).toMatchObject(response);
  expect(body.guidance).toContain('wait for explicit approval');
  expect(body.guidance).toContain('/app/settings?tab=data-sources');
  expect(result.stderr).toContain(body.requestId);
  expect(requests).toHaveLength(1);
});

it('executes Find Tools through the same API and refuses keyless access', async () => {
  const args = ['find-tools', '--options', '{"providers":["fred"]}'];
  expect((await cli(args, '')).code).toBe(1);
  expect(requests).toHaveLength(0);
  expect((await cli(args)).code).toBe(0);
  expect(requests[0]).toMatchObject({
    url: '/v2/scrape',
    body: {
      alexandria: [
        {
          provider: 'firecrawl',
          capability: 'find-tools',
          options: { providers: ['fred'] },
        },
      ],
    },
  });
});

it('preserves charged SDK failures', async () => {
  status = 402;
  response = {
    success: false,
    error: 'Provider call failed after billing',
    code: 'PROVIDER_ERROR',
    chargeId: 'charge-1',
  };
  const result = await cli(['scrape', '--alexandria', 'provider/lookup']);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject(response);
  expect(requests).toHaveLength(1);
});

it('retains successful results and billing when one provider fails', async () => {
  response.data.alexandria.push({
    provider: 'other',
    capability: 'lookup',
    error: { code: 'PROVIDER_ERROR', message: 'Unavailable', status: 503 },
  });
  const result = await cli([
    'scrape',
    '--alexandria',
    'provider/lookup',
    'other/lookup',
  ]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject(response);
  expect(requests).toHaveLength(1);
});

it('keeps URL scrape tool contracts in the output', async () => {
  response = {
    success: true,
    data: { markdown: 'Example', tools: [{ provider: 'fred' }] },
  };
  const result = await cli(['scrape', 'https://example.com', '--domain-tools']);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(response.data);
  expect(requests[0]).toMatchObject({
    url: '/v2/scrape',
    body: { url: 'https://example.com', domainTools: true },
  });
});

it('keeps natural query text and disables only domain matching when requested', async () => {
  response = { success: true, data: { web: [], tools: [] } };
  const query = 'homes for sale in Lower Haight under $1 million';
  const result = await cli(['search', query, '--no-domain-tools', '--json']);
  expect(result.code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: '/v2/search',
    body: {
      query,
      domainTools: false,
      sources: [{ type: 'web' }, { type: 'alexandria' }],
    },
  });
});

it('presents tools compactly after web results while JSON preserves full contracts', async () => {
  const tool = {
    provider: 'fred',
    capability: 'series/observations',
    name: 'Economic observations',
    description: 'Read an economic series',
    creditsCost: 5,
    perRecord: true,
    options: [{ name: 'series_id', required: true }],
    example: { large: 'EXAMPLE_PAYLOAD' },
  };
  response = {
    success: true,
    data: {
      web: [{ url: 'https://example.com', title: 'GDP report' }],
      tools: [tool],
    },
  };
  const readable = await cli(['search', 'GDP growth']);
  expect(readable.stdout.indexOf('GDP report')).toBeLessThan(
    readable.stdout.indexOf('=== Alexandria Tools ===')
  );
  expect(readable.stdout).toContain('5 credits per record');
  expect(readable.stdout).toContain('scrape --alexandria');
  expect(readable.stdout).not.toContain('EXAMPLE_PAYLOAD');
  const json = await cli(['search', 'GDP growth', '--json']);
  expect(JSON.parse(json.stdout).data.tools).toEqual([tool]);
  expect(requests.every((request) => request.url === '/v2/search')).toBe(true);
});

it('find-tools and explicit meta-tool execution use the same Scrape request', async () => {
  const options = '{"providers":["fred"],"level":"tools","limit":100}';
  expect(
    (await cli(['find-tools', '--options', options, '--request-id', 'meta-1']))
      .code
  ).toBe(0);
  expect(
    (
      await cli([
        'scrape',
        '--alexandria',
        'firecrawl/find-tools',
        '--options',
        options,
        '--request-id',
        'meta-1',
      ])
    ).code
  ).toBe(0);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0].url).toBe('/v2/scrape');
});

it('discovers a known URL and follows its returned meta-tool request without executing providers', async () => {
  const next = {
    provider: 'firecrawl',
    capability: 'find-tools',
    options: { providers: ['fred'], level: 'tools', limit: 100 },
  };
  response.data.alexandria = [
    {
      provider: 'firecrawl',
      capability: 'find-tools',
      creditsCost: 0,
      data: { items: [{ provider: 'fred', next }], next: null },
    },
  ];
  const first = await cli([
    'find-tools',
    'https://fred.stlouisfed.org',
    '--json',
  ]);
  expect(first.code).toBe(0);
  const returned = JSON.parse(first.stdout).data.alexandria[0].data.items[0]
    .next;
  expect(
    (await cli(['find-tools', '--request', JSON.stringify(returned), '--json']))
      .code
  ).toBe(0);
  expect(requests[0].body.alexandria[0].options).toEqual({
    urls: ['https://fred.stlouisfed.org'],
  });
  expect(requests[1].body.alexandria).toEqual([next]);
  expect(requests.every((request) => request.url === '/v2/scrape')).toBe(true);
});

it('rejects provider execution and mixed arguments through the find-tools shortcut', async () => {
  for (const args of [
    [
      '--request',
      '{"provider":"fred","capability":"series/observations","options":{}}',
    ],
    [
      'https://example.com',
      '--request',
      '{"provider":"firecrawl","capability":"find-tools","options":{}}',
    ],
    [
      '--options',
      '{}',
      '--request',
      '{"provider":"firecrawl","capability":"find-tools","options":{}}',
    ],
  ]) {
    expect((await cli(['find-tools', ...args])).code).toBe(1);
  }
  expect(requests).toHaveLength(0);
});

it('retains empty discovery results and reports nested meta-tool errors as failures', async () => {
  response.data = {
    alexandria: [
      {
        provider: 'firecrawl',
        capability: 'find-tools',
        creditsCost: 0,
        data: { items: [], total: 0, next: null },
      },
    ],
    creditsCost: 0,
  };
  const empty = await cli(['find-tools', 'https://example.com', '--json']);
  expect(empty.code).toBe(0);
  expect(JSON.parse(empty.stdout).data.alexandria[0].data).toEqual({
    items: [],
    total: 0,
    next: null,
  });
  response.data.alexandria = [
    {
      provider: 'firecrawl',
      capability: 'find-tools',
      error: {
        code: 'invalid_option',
        message: 'Unknown discovery level.',
        status: 400,
      },
    },
  ];
  const invalid = await cli([
    'find-tools',
    '--options',
    '{"level":"capabilities"}',
    '--json',
  ]);
  expect(invalid.code).toBe(1);
  expect(JSON.parse(invalid.stdout).data.alexandria[0].error.code).toBe(
    'invalid_option'
  );
});

it('requests web content with search --scrape without executing returned tools', async () => {
  response = {
    success: true,
    data: {
      web: [{ url: 'https://example.com', markdown: 'content' }],
      tools: [{ provider: 'fred', capability: 'series/observations' }],
    },
  };
  expect((await cli(['search', 'GDP', '--scrape', '--json'])).code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('/v2/search');
  expect(requests[0].body.scrapeOptions.formats).toEqual([
    { type: 'markdown' },
  ]);
  expect(requests[0].body.alexandria).toBeUndefined();
});

const THREAD_ID = '0d0e6f7a-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const RUN_ID = '7c1e2d3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f';

it('continues a thread and returns the thread the run belongs to', async () => {
  response = { success: true, id: RUN_ID, threadId: THREAD_ID, threadTurn: 2 };
  const result = await cli([
    'agent',
    'And the heading?',
    '--thread',
    THREAD_ID,
    '--mode',
    'chat',
    '--effort',
    'low',
    '--model',
    'spark-2',
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    success: true,
    data: {
      jobId: RUN_ID,
      status: 'processing',
      threadId: THREAD_ID,
      threadTurn: 2,
    },
  });
  expect(requests[0]).toMatchObject({
    url: '/v2/agent',
    headers: { authorization: 'Bearer fc-test' },
    body: {
      prompt: 'And the heading?',
      threadId: THREAD_ID,
      mode: 'chat',
      effort: 'low',
      model: 'spark-2',
      integration: 'cli',
    },
  });
  expect(requests[0].body).not.toHaveProperty('urls');
});

it('keeps the plain start request free of thread fields', async () => {
  response = { success: true, id: RUN_ID, threadId: THREAD_ID, threadTurn: 1 };
  const result = await cli(['agent', 'Extract the page title.']);
  expect(result.code).toBe(0);
  for (const key of ['threadId', 'mode', 'effort']) {
    expect(requests[0].body).not.toHaveProperty(key);
  }
  expect(JSON.parse(result.stdout).data).toMatchObject({
    threadId: THREAD_ID,
    threadTurn: 1,
  });
});

it('rejects a malformed --thread before calling the API', async () => {
  const result = await cli(['agent', 'And the heading?', '--thread', 'nope']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('--thread requires a thread ID');
  expect(requests).toHaveLength(0);
});

it('surfaces chat replies and thread position on status', async () => {
  response = {
    success: true,
    status: 'completed',
    data: null,
    expiresAt: '2026-09-17T00:00:00.000Z',
    creditsUsed: 3,
    threadId: THREAD_ID,
    threadTurn: 2,
    mode: 'chat',
    message: 'The page is about example domains.',
    suggestions: [{ label: 'Dig deeper', prompt: 'List every link.' }],
  };
  const json = await cli(['agent', RUN_ID, '--json']);
  expect(json.code).toBe(0);
  expect(requests[0].url).toBe(`/v2/agent/${RUN_ID}`);
  expect(JSON.parse(json.stdout)).toMatchObject({
    success: true,
    id: RUN_ID,
    status: 'completed',
    threadId: THREAD_ID,
    threadTurn: 2,
    mode: 'chat',
    message: 'The page is about example domains.',
    suggestions: [{ label: 'Dig deeper', prompt: 'List every link.' }],
  });
  const readable = await cli(['agent', RUN_ID]);
  expect(readable.stdout).toContain(`Thread: ${THREAD_ID} (turn 2)`);
  expect(readable.stdout).toContain('Mode: chat');
  expect(readable.stdout).toContain('The page is about example domains.');
  expect(readable.stdout).toContain('Dig deeper: List every link.');
});

it('relays thread_busy conflicts when a turn is still running', async () => {
  status = 409;
  response = {
    success: false,
    code: 'thread_busy',
    error: 'This thread already has a run in progress',
    runId: RUN_ID,
  };
  const result = await cli(['agent', 'Again?', '--thread', THREAD_ID]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('already has a run in progress');
  expect(requests).toHaveLength(1);
});

it('lists a thread through the thread endpoint', async () => {
  response = {
    success: true,
    thread: {
      id: THREAD_ID,
      createdAt: '2026-09-16T10:00:00.000Z',
      updatedAt: '2026-09-16T10:05:00.000Z',
      status: 'idle',
      runs: [
        {
          id: RUN_ID,
          turn: 1,
          mode: 'extract',
          prompt: 'Extract the page title.',
          status: 'succeeded',
          createdAt: '2026-09-16T10:00:00.000Z',
          finishedAt: '2026-09-16T10:01:00.000Z',
          creditsUsed: 5,
          message: null,
          data: { title: 'Example Domain' },
        },
      ],
    },
  };
  const json = await cli([
    'agent',
    'thread',
    THREAD_ID,
    '--include-data',
    '--json',
  ]);
  expect(json.code).toBe(0);
  expect(requests[0]).toMatchObject({
    url: `/v2/agent/threads/${THREAD_ID}?includeData=true`,
    headers: { authorization: 'Bearer fc-test' },
  });
  expect(JSON.parse(json.stdout)).toEqual(response);

  const readable = await cli(['agent', 'thread', THREAD_ID]);
  expect(readable.code).toBe(0);
  expect(requests[1].url).toBe(`/v2/agent/threads/${THREAD_ID}`);
  expect(readable.stdout).toContain(`Thread ID: ${THREAD_ID}`);
  expect(readable.stdout).toContain('Turn 1 (extract) - succeeded');
  expect(readable.stdout).toContain('Extract the page title.');
  expect(readable.stdout).toContain('"title":"Example Domain"');
});

it('fails clearly on an unknown thread', async () => {
  status = 404;
  response = {
    success: false,
    code: 'thread_not_found',
    error: 'Agent thread not found',
  };
  const result = await cli(['agent', 'thread', THREAD_ID]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Agent thread not found');
  expect(requests).toHaveLength(1);
  const malformed = await cli(['agent', 'thread', 'nope']);
  expect(malformed.code).toBe(1);
  expect(requests).toHaveLength(1);
});

it('falls back to category browsing after an unknown provider, but preserves other failures', async () => {
  responseFor = (body) =>
    body.alexandria[0].options.providers
      ? {
          success: true,
          scrape_id: 'discovery-1',
          data: {
            creditsCost: 0,
            alexandria: [
              {
                provider: 'firecrawl',
                capability: 'find-tools',
                error: {
                  status: 400,
                  code: 'invalid_request',
                  message:
                    'Unknown or unavailable providers. Browse the catalogue for accessible IDs; use query for natural-language search.',
                },
              },
            ],
          },
        }
      : catalogue('providers', [{ id: 'amazon-com', provider: 'amazon-com' }]);
  const result = await cli(['list', 'shopping', '--json']);
  expect(result.code, JSON.stringify(result)).toBe(0);
  expect(requests.map(({ body }) => body.alexandria[0].options)).toEqual([
    { providers: ['shopping'], level: 'tools', limit: 20 },
    { categories: ['shopping'], level: 'providers', limit: 20 },
  ]);
  expect(result.stdout).toContain('amazon-com');
  requests.length = 0;
  responseFor = () => ({
    success: false,
    error: 'Rate limit exceeded',
    code: 'rate_limited',
  });
  expect((await cli(['list', 'shopping', '--json'])).code).toBe(1);
  expect(requests).toHaveLength(1);
});
