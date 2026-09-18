import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('sends shorthand and explicit calls identically, rejects bare names locally, and preserves tool errors', async () => {
  const requests: { path: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: request.url!, body });
    const call = body.alexandria[0];
    const result =
      call.provider === 'benzing'
        ? {
            ...call,
            error: {
              code: 'unknown_provider',
              message: 'Unknown provider "benzing".',
              status: 404,
            },
          }
        : { ...call, data: { results: [] } };
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        success: true,
        data: { alexandria: [result], creditsCost: 0 },
      })
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (done, reject) => {
        const child = spawn(
          process.execPath,
          [resolve('dist/index.js'), 'scrape', ...args],
          {
            env: {
              ...process.env,
              FIRECRAWL_API_URL: `http://127.0.0.1:${address.port}`,
              FIRECRAWL_API_KEY: 'fc-local-test',
              FIRECRAWL_NO_UPDATE_CHECK: '1',
              FIRECRAWL_NO_TELEMETRY: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => done({ code, stdout, stderr }));
      }
    );
  try {
    const common = [
      '--options',
      '{"pageSize":1}',
      '--request-id',
      'local-test',
    ];
    expect((await run(['benzinga/news/search', ...common])).code).toBe(0);
    expect(
      (await run(['--alexandria', 'benzinga/news/search', ...common])).code
    ).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0].body.url).toBeUndefined();
    expect(requests[1].body.url).toBeUndefined();
    expect(requests[0].path).toBe('/v2/scrape');
    expect(requests[0].body.alexandria).toEqual([
      {
        provider: 'benzinga',
        capability: 'news/search',
        options: { pageSize: 1 },
      },
    ]);
    const bare = await run(['amazon']);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain('https://amazon.com (suggestion only)');
    expect(bare.stderr).toContain('firecrawl list');
    expect(requests).toHaveLength(2);
    const bareUrl = await run(['--url', 'amazon']);
    expect(bareUrl.code).toBe(1);
    expect(bareUrl.stderr).toContain('https://amazon.com (suggestion only)');
    expect(requests).toHaveLength(2);
    const typo = await run(['benzing/news/search', ...common]);
    expect(typo.code).toBe(1);
    expect(typo.stdout).toContain('unknown_provider');
    expect(requests).toHaveLength(3);
    expect(requests[2].body.url).toBeUndefined();
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done()))
    );
  }
}, 15_000);
