import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('search --scrape sends onlyMainContent only when a flag sets it', async () => {
  const requests: { path: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url!,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ success: true, data: { web: [] } }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  const run = (args: string[]) =>
    new Promise<{ code: number | null; stderr: string }>((done, reject) => {
      const child = spawn(
        process.execPath,
        [resolve('dist/index.js'), 'search', 'firecrawl', '--scrape', ...args],
        {
          env: {
            ...process.env,
            FIRECRAWL_API_URL: `http://127.0.0.1:${address.port}`,
            FIRECRAWL_API_KEY: 'fc-local-test',
            FIRECRAWL_NO_UPDATE_CHECK: '1',
            FIRECRAWL_NO_TELEMETRY: '1',
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        }
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => done({ code, stderr }));
    });
  try {
    expect((await run([])).code).toBe(0);
    expect((await run(['--only-main-content'])).code).toBe(0);
    expect((await run(['--full-page'])).code).toBe(0);
    expect(requests.map((r) => r.path)).toEqual([
      '/v2/search',
      '/v2/search',
      '/v2/search',
    ]);
    expect(requests[0].body.scrapeOptions).not.toHaveProperty(
      'onlyMainContent'
    );
    expect(requests[1].body.scrapeOptions.onlyMainContent).toBe(true);
    expect(requests[2].body.scrapeOptions.onlyMainContent).toBe(false);

    const both = await run(['--only-main-content', '--full-page']);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain(
      'Use either --only-main-content or --full-page, not both'
    );
    expect(requests).toHaveLength(3);
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done()))
    );
  }
}, 15_000);
