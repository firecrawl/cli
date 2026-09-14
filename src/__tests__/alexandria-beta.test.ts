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

it('keeps beta options out of normal help and respects explicit web-only search', async () => {
  for (const args of [['--help'], ['search', '--help'], ['scrape', '--help']]) {
    const result = await cli(args);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(
      /alexandria|find-tools|domain-tools|--enable/i
    );
  }
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
  expect(readable.stdout).toContain('=== Tools ===');
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
