import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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
const home = mkdtempSync(join(tmpdir(), 'alexandria-cli-'));

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(raw),
    });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
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
