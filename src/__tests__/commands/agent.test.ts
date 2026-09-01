/**
 * Tests for agent command threads
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  APPROVE_PROMPT,
  DECLINE_PROMPT,
  executeAgent,
  executeAgentThread,
  formatPendingApproval,
  formatThread,
  handleAgentCommand,
} from '../../commands/agent';
import { getClient } from '../../utils/client';
import { getRememberedThread, rememberThread } from '../../utils/agent-threads';
import { initializeConfig } from '../../utils/config';
import { setupTest, teardownTest } from '../utils/mock-client';

const { configDir } = vi.hoisted(() => ({ configDir: { path: '' } }));

vi.mock('../../utils/credentials', () => ({
  loadCredentials: () => null,
  getConfigDirectoryPath: () => configDir.path,
}));

vi.mock('../../utils/client', async () => {
  const actual = await vi.importActual('../../utils/client');
  return { ...actual, getClient: vi.fn() };
});

const API_KEY = 'fc-test-key';

function jsonResponse(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
  };
}

function lastRequestBody(mockFetch: ReturnType<typeof vi.fn>, index = 0): any {
  const [, init] = mockFetch.mock.calls[index] as [string, { body: string }];
  return JSON.parse(init.body);
}

describe('agent threads', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockClient: any;

  beforeEach(() => {
    setupTest();
    configDir.path = fs.mkdtempSync(
      path.join(os.tmpdir(), 'firecrawl-agent-test-')
    );
    initializeConfig({ apiKey: API_KEY, apiUrl: 'https://api.firecrawl.dev' });

    mockClient = { startAgent: vi.fn(), getAgentStatus: vi.fn() };
    vi.mocked(getClient).mockReturnValue(mockClient as any);

    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(configDir.path, { recursive: true, force: true });
    teardownTest();
    vi.clearAllMocks();
  });

  describe('continuing a thread', () => {
    it('sends the remembered thread and records the new run', async () => {
      rememberThread(API_KEY, { threadId: 'thread-1', runId: 'run-1' });
      mockFetch.mockResolvedValue(
        jsonResponse(200, {
          success: true,
          id: 'run-2',
          threadId: 'thread-1',
          threadTurn: 2,
        })
      );

      const result = await executeAgent({
        prompt: 'Which tier includes SSO?',
        continue: true,
        apiKey: API_KEY,
      });

      expect(result.success).toBe(true);
      const [url, init] = mockFetch.mock.calls[0] as [
        string,
        { method: string; headers: Record<string, string> },
      ];
      expect(url).toBe('https://api.firecrawl.dev/v2/agent');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(lastRequestBody(mockFetch)).toEqual({
        prompt: 'Which tier includes SSO?',
        integration: 'cli',
        threadId: 'thread-1',
      });

      const remembered = getRememberedThread(API_KEY);
      expect(remembered?.lastThreadId).toBe('thread-1');
      expect(remembered?.lastRunId).toBe('run-2');
    });

    it('does not reuse a thread remembered for another API key', async () => {
      rememberThread('fc-other-key', { threadId: 'other-thread' });
      mockFetch.mockResolvedValue(
        jsonResponse(200, { success: true, id: 'run-2', threadId: 'thread-9' })
      );

      await executeAgent({
        prompt: 'follow up',
        continue: true,
        mode: 'chat',
        apiKey: API_KEY,
      });

      expect(lastRequestBody(mockFetch).threadId).toBeUndefined();
      expect(getRememberedThread('fc-other-key')?.lastThreadId).toBe(
        'other-thread'
      );
    });

    it('says so when there is no remembered thread to continue', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      mockFetch.mockResolvedValue(
        jsonResponse(200, { success: true, id: 'run-1', threadId: 'thread-1' })
      );

      await executeAgent({
        prompt: 'start something',
        continue: true,
        mode: 'chat',
        apiKey: API_KEY,
      });

      const written = stderr.mock.calls.map((call) => call[0]).join('');
      expect(written).toContain('No remembered thread; starting a new one.');
      stderr.mockRestore();
    });

    it('lets --thread override the remembered thread', async () => {
      rememberThread(API_KEY, { threadId: 'thread-1' });
      mockFetch.mockResolvedValue(
        jsonResponse(200, { success: true, id: 'run-5', threadId: 'thread-9' })
      );

      await executeAgent({
        prompt: 'follow up',
        thread: 'thread-9',
        continue: true,
        apiKey: API_KEY,
      });

      expect(lastRequestBody(mockFetch).threadId).toBe('thread-9');
      expect(getRememberedThread(API_KEY)?.lastThreadId).toBe('thread-9');
    });

    it('clears the entry and starts fresh when the thread is gone', async () => {
      rememberThread(API_KEY, { threadId: 'thread-gone' });
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse(404, {
            success: false,
            error: 'Thread not found',
            code: 'thread_not_found',
          })
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            success: true,
            id: 'run-7',
            threadId: 'thread-new',
          })
        );

      const result = await executeAgent({
        prompt: 'follow up',
        continue: true,
        mode: 'chat',
        apiKey: API_KEY,
      });

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(lastRequestBody(mockFetch, 0).threadId).toBe('thread-gone');
      expect(lastRequestBody(mockFetch, 1).threadId).toBeUndefined();
      expect(getRememberedThread(API_KEY)?.lastThreadId).toBe('thread-new');

      const written = stderr.mock.calls.map((call) => call[0]).join('');
      expect(written).toContain('That thread is gone; starting a new one.');
      stderr.mockRestore();
    });

    it('clears the entry when an expired thread is gone for good', async () => {
      rememberThread(API_KEY, { threadId: 'thread-expired' });
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse(410, {
            success: false,
            error: 'Thread expired',
            code: 'thread_expired',
          })
        )
        .mockResolvedValueOnce(
          jsonResponse(200, { success: true, id: 'run-8' })
        );

      await executeAgent({
        prompt: 'follow up',
        continue: true,
        mode: 'chat',
        apiKey: API_KEY,
      });

      expect(getRememberedThread(API_KEY)).toBeNull();
    });

    it('reports an API without thread support', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(400, {
          success: false,
          error: 'Unrecognized key in body: threadId',
        })
      );

      const result = await executeAgent({
        prompt: 'follow up',
        thread: 'thread-1',
        apiKey: API_KEY,
      });

      expect(result).toEqual({
        success: false,
        error: 'This Firecrawl API does not support threads yet',
      });
    });
  });

  describe('approvals', () => {
    it('--approve sends the control prompt and the approve payload', async () => {
      rememberThread(API_KEY, { threadId: 'thread-1' });
      mockFetch.mockResolvedValue(
        jsonResponse(200, { success: true, id: 'run-9', threadId: 'thread-1' })
      );

      await executeAgent({
        prompt: '',
        exchange: { approve: { approvalId: 'a1', always: true } },
        apiKey: API_KEY,
      });

      expect(lastRequestBody(mockFetch)).toEqual({
        prompt: APPROVE_PROMPT,
        integration: 'cli',
        threadId: 'thread-1',
        exchange: { approve: { approvalId: 'a1', always: true } },
      });
    });

    it('--decline sends its own control prompt', async () => {
      rememberThread(API_KEY, { threadId: 'thread-1' });
      mockFetch.mockResolvedValue(
        jsonResponse(200, { success: true, id: 'run-10', threadId: 'thread-1' })
      );

      await executeAgent({
        prompt: '',
        exchange: { decline: { approvalId: 'a1' } },
        apiKey: API_KEY,
      });

      const body = lastRequestBody(mockFetch);
      expect(body.prompt).toBe(DECLINE_PROMPT);
      expect(body.exchange).toEqual({ decline: { approvalId: 'a1' } });
      expect(body.threadId).toBe('thread-1');
    });

    it('refuses to resolve an approval with no thread to resolve it in', async () => {
      const result = await executeAgent({
        prompt: '',
        exchange: { approve: { approvalId: 'a1' } },
        apiKey: API_KEY,
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toContain('No thread to resolve that approval in');
    });

    it('renders a pending approval and the commands that resolve it', () => {
      const rendered = formatPendingApproval({
        id: 'a1',
        reason: 'One call answers this.',
        calls: [
          {
            id: 'c1',
            provider: 'provider-slug',
            capability: 'capability/slug',
            input: { symbol: 'ACME' },
            creditsEstimate: 5,
          },
        ],
      });

      expect(rendered).toContain('Awaiting approval: a1');
      expect(rendered).toContain('One call answers this.');
      expect(rendered).toContain('Provider');
      expect(rendered).toContain('Capability');
      expect(rendered).toContain('Est. credits');
      expect(rendered).toContain('provider-slug');
      expect(rendered).toContain('capability/slug');
      expect(rendered).toContain('{"symbol":"ACME"}');
      expect(rendered).toContain('firecrawl agent --approve a1');
      expect(rendered).toContain('firecrawl agent --decline a1');
    });
  });

  describe('chat output', () => {
    it('prints the message before the data and lists follow-ups', async () => {
      const stdout = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      mockFetch.mockResolvedValue(
        jsonResponse(200, { success: true, id: 'run-1', threadId: 'thread-1' })
      );
      mockClient.getAgentStatus.mockResolvedValue({
        success: true,
        status: 'completed',
        data: { tiers: ['free'] },
        creditsUsed: 31,
        expiresAt: '2026-01-01T00:00:00.000Z',
        threadId: 'thread-1',
        threadTurn: 2,
        mode: 'chat',
        message: 'Only the Enterprise tier lists SSO.',
        suggestions: [
          { label: 'Seats?', prompt: 'Does the Team tier cap seats?' },
        ],
      });

      await handleAgentCommand({
        prompt: 'Which tier includes SSO?',
        mode: 'chat',
        wait: true,
        pollInterval: 0.001,
        apiKey: API_KEY,
      });

      const written = stdout.mock.calls.map((call) => call[0]).join('');
      expect(written.indexOf('Only the Enterprise tier lists SSO.')).toBe(0);
      expect(
        written.indexOf('Only the Enterprise tier lists SSO.')
      ).toBeLessThan(written.indexOf('"tiers"'));
      expect(written).toContain('Try next:');
      expect(written).toContain(
        'firecrawl agent --continue "Does the Team tier cap seats?"'
      );

      const errors = stderr.mock.calls.map((call) => call[0]).join('');
      expect(errors).toContain('Thread: thread-1  (continue with --continue)');

      stdout.mockRestore();
      stderr.mockRestore();
    });
  });

  describe('agent thread <id>', () => {
    it('reads the conversation and renders its turns', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(200, {
          success: true,
          thread: {
            id: 'thread-1',
            status: 'idle',
            updatedAt: '2026-01-01T00:00:00.000Z',
            runs: [
              {
                id: 'run-1',
                turn: 1,
                mode: 'chat',
                prompt: 'List the pricing tiers',
                status: 'succeeded',
                creditsUsed: 212,
                data: { tiers: ['free'] },
              },
              {
                id: 'run-2',
                turn: 2,
                mode: 'chat',
                prompt: 'Which tier includes SSO?',
                status: 'succeeded',
                creditsUsed: 31,
                message: 'Only the Enterprise tier lists SSO.',
                suggestions: [
                  { label: 'Seats?', prompt: 'Does the Team tier cap seats?' },
                ],
              },
            ],
          },
        })
      );

      const result = await executeAgentThread('thread-1', { apiKey: API_KEY });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe(
        'https://api.firecrawl.dev/v2/agent/threads/thread-1?includeData=true'
      );
      expect(result.success).toBe(true);

      const rendered = formatThread(result.thread!);
      expect(rendered).toContain('Thread: thread-1');
      expect(rendered).toContain('Turn 1 · chat · succeeded · 212 credits');
      expect(rendered).toContain('You: List the pricing tiers');
      expect(rendered).toContain('"tiers"');
      expect(rendered).toContain('Turn 2 · chat · succeeded · 31 credits');
      expect(rendered).toContain('Agent: Only the Enterprise tier lists SSO.');
      expect(rendered).toContain(
        'firecrawl agent --continue "Does the Team tier cap seats?"'
      );
      expect(rendered.indexOf('Turn 1')).toBeLessThan(
        rendered.indexOf('Turn 2')
      );
    });
  });

  describe('runs without thread flags', () => {
    it('still starts through the SDK with the same arguments', async () => {
      mockClient.startAgent.mockResolvedValue({ success: true, id: 'run-1' });

      const result = await executeAgent({
        prompt: 'Find the pricing plans',
        apiKey: API_KEY,
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockClient.startAgent).toHaveBeenCalledWith({
        prompt: 'Find the pricing plans',
        integration: 'cli',
      });
      expect(result).toEqual({
        success: true,
        data: { jobId: 'run-1', status: 'processing' },
      });
    });
  });
});
