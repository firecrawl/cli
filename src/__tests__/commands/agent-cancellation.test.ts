import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';

const exec = promisify(execFile);
const JOB_ID = '019e5299-8235-7538-9f62-bc39d4b058f1';
const home = mkdtempSync(join(tmpdir(), 'agent-cancellation-cli-'));
let server: Server;
let baseUrl: string;
let statuses: string[];
let polls: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'POST') {
      res.end(JSON.stringify({ success: true, id: JOB_ID }));
      return;
    }
    const status = statuses[Math.min(polls++, statuses.length - 1)];
    res.end(
      JSON.stringify({
        success: true,
        status,
        data: { answer: 'result' },
        creditsUsed: 12,
        threadId: 'thread-fixture',
        error: status === 'failed' ? 'Agent reached max credits' : undefined,
      })
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

async function cli(sequence: string[], prompt = 'research example') {
  statuses = sequence;
  polls = 0;
  try {
    return {
      code: 0,
      ...(await exec(
        process.execPath,
        [
          'dist/index.js',
          'agent',
          prompt,
          '--wait',
          '--poll-interval',
          '0.01',
          '--timeout',
          '1',
          '--json',
        ],
        {
          timeout: 10000,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            FIRECRAWL_API_KEY: 'fc-test',
            FIRECRAWL_API_URL: baseUrl,
            FIRECRAWL_NO_UPDATE_CHECK: '1',
          },
        }
      )),
    };
  } catch (error) {
    return error as { code: number; stdout: string; stderr: string };
  }
}

it.each([['cancelled'], ['processing', 'cancelled']])(
  'stops prompt-start polling at cancellation (%j)',
  async (...sequence) => {
    const result = await cli(sequence);
    expect(result.code).toBe(0);
    expect(polls).toBe(sequence.length);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      id: JOB_ID,
      status: 'cancelled',
      creditsUsed: 12,
      threadId: 'thread-fixture',
    });
    expect(result.stderr).not.toContain('still processing');
  }
);

it('keeps existing-job cancellation successful', async () => {
  const result = await cli(['cancelled'], JOB_ID);
  expect(result.code).toBe(0);
  expect(polls).toBe(1);
  expect(JSON.parse(result.stdout).status).toBe('cancelled');
});

it('keeps processing-to-completed successful', async () => {
  const result = await cli(['processing', 'completed']);
  expect(result.code).toBe(0);
  expect(polls).toBe(2);
  expect(JSON.parse(result.stdout).data).toEqual({ answer: 'result' });
});

it('keeps failed jobs unsuccessful', async () => {
  const result = await cli(['failed']);
  expect(result.code).toBe(1);
  expect(polls).toBe(1);
  expect(result.stderr).toContain('Agent reached max credits');
});

it('still times out when the agent remains processing', async () => {
  const result = await cli(['processing']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Agent still processing');
});
