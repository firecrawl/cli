import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';

const exec = promisify(execFile);
let server: Server;
let baseUrl: string;
let payload: Record<string, unknown> = {};
let responseStatus = 200;
const home = mkdtempSync(join(tmpdir(), 'agent-status-cli-'));

beforeAll(async () => {
  await exec(process.execPath, [
    join(process.cwd(), 'node_modules/typescript/bin/tsc'),
  ]);
  server = createServer((req, res) => {
    res.writeHead(responseStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  rmSync(home, { recursive: true, force: true });
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

const JOB_ID = '019e5299-8235-7538-9f62-bc39d4b058f1';

it('exits nonzero and surfaces the server error when checking a failed agent without --wait', async () => {
  payload = {
    success: true,
    status: 'failed',
    error: 'Refusal: Error: Agent reached max credits',
    data: null,
  };
  const result = await cli(['agent', JOB_ID, '--json']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Agent reached max credits');
});

it('keeps success semantics for a completed agent status', async () => {
  payload = {
    success: true,
    status: 'completed',
    data: { answer: 'done' },
    creditsUsed: 12,
  };
  const result = await cli(['agent', JOB_ID, '--json']);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.status).toBe('completed');
  expect(parsed.data).toEqual({ answer: 'done' });
});

it('keeps success semantics for a processing agent status', async () => {
  payload = { success: true, status: 'processing' };
  const result = await cli(['agent', JOB_ID, '--json']);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.status).toBe('processing');
});

it('keeps success semantics for a cancelled agent status', async () => {
  payload = { success: true, status: 'cancelled' };
  const result = await cli(['agent', JOB_ID, '--json']);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.success).toBe(true);
  expect(parsed.status).toBe('cancelled');
});

it('keeps failure semantics when the server rejects the status request', async () => {
  payload = { success: false, error: 'Unauthorized: Invalid API key' };
  responseStatus = 401;
  const result = await cli(['agent', JOB_ID, '--json']);
  responseStatus = 200;
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Unauthorized: Invalid API key');
});

it.each([undefined, null, ''])(
  'uses the failure fallback for a missing or empty error (%j)',
  async (error) => {
    payload = { success: true, status: 'failed', data: null, error };
    const result = await cli(['agent', JOB_ID, '--json']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Agent failed');
  }
);
