import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../utils/credentials', async () => ({
  ...(await vi.importActual('../../utils/credentials')),
  getConfigDirectoryPath: () => state.dir,
}));

vi.mock('../../utils/agent-origin', () => ({
  getCliOrigin: () => 'cli.test@1.0.0',
}));

vi.mock('../../utils/client', async () => ({
  ...(await vi.importActual('../../utils/client')),
  getClient: vi.fn(),
}));

import { requestAlexandria } from '../../commands/alexandria';
import {
  executeEndpointFeedback,
  handleEndpointFeedbackCommand,
  parseCallRatingArg,
  parseFeedbackTokenArg,
} from '../../commands/feedback';
import { getClient } from '../../utils/client';
import { initializeConfig } from '../../utils/config';
import {
  feedbackTokenScope,
  readFeedbackTokens,
  recordFeedbackTokens,
} from '../../utils/alexandria-feedback-tokens';
import { setupTest, teardownTest } from '../utils/mock-client';

const scope = feedbackTokenScope('test-api-key');
const base = {
  endpoint: 'alexandria' as const,
  rating: 'good' as const,
  requestedWebsite: {
    url: 'https://example.com',
    requestedFunctionality: 'Read records',
  },
  rationale: 'Worked',
};

describe('alexandria feedback tokens in the CLI', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), 'fc-cli-tokens-'));
    setupTest();
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        feedbackId: 'fb',
        creditsRefunded: 1,
      }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
    rmSync(state.dir, { recursive: true, force: true });
  });

  const sentBody = () => JSON.parse(mockFetch.mock.calls[0][1].body);

  it('records tokens from Alexandria results and prints a ref per call', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getClient).mockReturnValue({
      scrape: vi.fn().mockResolvedValue({
        creditsCost: 1,
        alexandria: [
          {
            provider: 'fred',
            capability: 'series',
            feedbackToken: 'tok-1',
            data: {},
          },
          {
            provider: 'fred',
            capability: 'bad',
            feedbackToken: 'tok-2',
            error: { code: 'x' },
          },
          {
            provider: 'firecrawl',
            capability: 'find-tools',
            feedbackToken: 'tok-3',
            data: {},
          },
          { provider: 'fred', capability: 'plain', data: {} },
        ],
      }),
    } as any);
    const envelope = await requestAlexandria(
      [
        { provider: 'fred', capability: 'series', options: {} },
        { provider: 'fred', capability: 'bad', options: {} },
        { provider: 'firecrawl', capability: 'find-tools', options: {} },
        { provider: 'fred', capability: 'plain', options: {} },
      ],
      {}
    );
    expect(readFeedbackTokens(scope).map((entry) => entry.token)).toEqual([
      'tok-1',
      'tok-2',
    ]);
    const lines = errors.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('Feedback ref c1: fred/series');
    expect(lines).toContain('Feedback ref c2: fred/bad');
    expect(JSON.stringify(lines)).not.toContain('tok-');
    expect(envelope.data.alexandria[0].feedbackToken).toBe('tok-1');
    errors.mockRestore();
  });

  it('sends the stored tokens and clears them on success', async () => {
    recordFeedbackTokens(scope, ['tok-1', 'tok-2']);
    const result = await executeEndpointFeedback(base);
    expect(result.success).toBe(true);
    expect(sentBody().tokens).toEqual(['tok-1', 'tok-2']);
    expect(sentBody().callRatings).toBeUndefined();
    expect(readFeedbackTokens(scope)).toEqual([]);
  });

  it('keeps the tokens when the submission fails', async () => {
    recordFeedbackTokens(scope, ['tok-1']);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ success: false, error: 'nope' }),
    });
    expect((await executeEndpointFeedback(base)).success).toBe(false);
    expect(readFeedbackTokens(scope)).toHaveLength(1);
  });

  it('maps call ratings from refs to tokens', async () => {
    recordFeedbackTokens(scope, ['tok-1', 'tok-2']);
    await executeEndpointFeedback({
      ...base,
      callRatings: [
        { ref: 'c1', rating: 'good' },
        { ref: 'c2', rating: 'bad' },
      ],
    });
    expect(sentBody().callRatings).toEqual([
      { token: 'tok-1', rating: 'good' },
      { token: 'tok-2', rating: 'bad' },
    ]);
    expect(sentBody().tokens).toEqual(['tok-1', 'tok-2']);
  });

  it('refuses an unknown call ref without sending anything', async () => {
    const result = await executeEndpointFeedback({
      ...base,
      callRatings: [{ ref: 'c9', rating: 'bad' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown call ref "c9"');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends explicit tokens in place of the stored ones', async () => {
    recordFeedbackTokens(scope, ['stored']);
    await executeEndpointFeedback({
      ...base,
      tokens: ['explicit-1', 'explicit-2'],
      callRatings: [{ ref: 'explicit-2', rating: 'partial' }],
    });
    expect(sentBody().tokens).toEqual(['explicit-1', 'explicit-2']);
    expect(sentBody().callRatings).toEqual([
      { token: 'explicit-2', rating: 'partial' },
    ]);
    expect(readFeedbackTokens(scope).map((entry) => entry.token)).toEqual([
      'stored',
    ]);
  });

  it('resolves call-rating refs only against explicit tokens when given', async () => {
    recordFeedbackTokens(scope, ['stored']);
    const result = await executeEndpointFeedback({
      ...base,
      tokens: ['explicit'],
      callRatings: [{ ref: 'c1', rating: 'bad' }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown call ref "c1"');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(readFeedbackTokens(scope)).toHaveLength(1);
  });

  it('sends no token fields when there are none', async () => {
    await executeEndpointFeedback(base);
    expect(sentBody().tokens).toBeUndefined();
    expect(sentBody().callRatings).toBeUndefined();
  });

  it('does not send tokens for job feedback', async () => {
    recordFeedbackTokens(scope, ['tok-1']);
    await executeEndpointFeedback({
      endpoint: 'scrape',
      jobId: '0193f6c5-1234-7890-abcd-1234567890ab',
      rating: 'good',
    });
    expect(sentBody().tokens).toBeUndefined();
    expect(readFeedbackTokens(scope)).toHaveLength(1);
  });

  it('reports rejected tokens from the API', async () => {
    recordFeedbackTokens(scope, ['tok-1']);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        feedbackId: 'fb',
        rejectedTokens: 1,
      }),
    });
    expect((await executeEndpointFeedback(base)).rejectedTokens).toBe(1);

    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      await handleEndpointFeedbackCommand(base);
      const output = stdout.mock.calls.map(([chunk]) => chunk).join('');
      expect(output).toContain(
        '1 call token(s) could not be verified and were ignored.'
      );
    } finally {
      stdout.mockRestore();
    }
  });

  it('parses call ratings and tokens', () => {
    expect(parseCallRatingArg('c3=good')).toEqual([
      { ref: 'c3', rating: 'good' },
    ]);
    expect(
      parseCallRatingArg('c4=BAD', parseCallRatingArg('c3=good'))
    ).toHaveLength(2);
    expect(() => parseCallRatingArg('c3')).toThrow('--call-rating');
    expect(() => parseCallRatingArg('=good')).toThrow('--call-rating');
    expect(() => parseCallRatingArg('c3=great')).toThrow('--rating');
    expect(parseFeedbackTokenArg('abc==')).toEqual(['abc==']);
    expect(() => parseFeedbackTokenArg('x'.repeat(1025))).toThrow('1-1024');
  });
});
