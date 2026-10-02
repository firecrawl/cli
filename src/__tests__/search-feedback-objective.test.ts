import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const requests: { url?: string; body: any }[] = [];
let server: Server;
let baseUrl: string;
const home = mkdtempSync(join(tmpdir(), 'search-feedback-cli-'));
const searchId = '00000000-0000-4000-8000-000000000001';

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: raw ? JSON.parse(raw) : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ success: true, feedbackId: 'f-1', creditsRefunded: 1 })
    );
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
});

async function cli(args: string[]) {
  try {
    return {
      code: 0,
      ...(await exec(process.execPath, ['dist/index.js', ...args], {
        timeout: 10000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          FIRECRAWL_API_KEY: 'fc-test',
          FIRECRAWL_API_URL: baseUrl,
          FIRECRAWL_NO_UPDATE_CHECK: '1',
        },
      })),
    };
  } catch (error) {
    return error as { code: number; stdout: string; stderr: string };
  }
}

const feedbackArgs = [
  'search-feedback',
  searchId,
  '--rating',
  'bad',
  '--missing-content',
  'Contract attachments',
  '--objective',
  '  Shortlist federal IT contracts to bid on this quarter  ',
  '--json',
];

it('sends the trimmed objective with search feedback', async () => {
  const result = await cli(feedbackArgs);

  expect(result.code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe(`/v2/search/${searchId}/feedback`);
  expect(requests[0].body).toMatchObject({
    rating: 'bad',
    objective: 'Shortlist federal IT contracts to bid on this quarter',
  });
});

it('still sends feedback without an objective', async () => {
  const index = feedbackArgs.indexOf('--objective');
  const withoutObjective = feedbackArgs.filter(
    (_, i) => i !== index && i !== index + 1
  );

  expect((await cli(withoutObjective)).code).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].body).not.toHaveProperty('objective');
});

it('rejects a blank objective before sending feedback', async () => {
  const blank = [...feedbackArgs];
  blank[feedbackArgs.indexOf('--objective') + 1] = '   ';

  expect((await cli(blank)).code).not.toBe(0);
  expect(requests).toHaveLength(0);
});
