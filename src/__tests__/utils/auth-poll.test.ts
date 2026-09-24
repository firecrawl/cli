/**
 * Tests for browser login polling
 *
 * The bug these cover: pollAuthStatus returned null for a pending user, for an
 * HTTP error and for a dead transport alike, so waitForAuth polled a blocked
 * host to timeout without printing anything.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollAuthStatus, waitForAuth, WEB_URL } from '../../utils/auth';

const SESSION_ID = 'a'.repeat(64);
const CODE_VERIFIER = 'b'.repeat(43);
// Deliberately not the production default, so a code path that ignores the
// --web-url override fails these tests instead of passing by coincidence.
const WEB_HOST = 'https://test-host.example';
const STATUS_URL = `${WEB_HOST}/api/auth/cli/status`;

/**
 * A Response body can only be read once, so every call must get a fresh one.
 * Returns a factory for `mockImplementation`, not a shared object.
 */
function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {}
): () => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      statusText: init.statusText ?? '',
      headers: { 'Content-Type': 'application/json' },
    });
}

/** Mimics Node's fetch: a bare TypeError carrying the real reason on `cause`. */
function transportFailure(code: string, reason: string): TypeError {
  const cause = new Error(reason) as Error & { code?: string };
  cause.code = code;
  return new TypeError('fetch failed', { cause });
}

describe('pollAuthStatus', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports pending when the user has not authorised yet', async () => {
    fetchMock.mockImplementation(jsonResponse({ status: 'pending' }));

    const result = await pollAuthStatus(SESSION_ID, CODE_VERIFIER, WEB_HOST);

    expect(result).toEqual({ status: 'pending' });
    expect(fetchMock).toHaveBeenCalledWith(
      STATUS_URL,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('reports complete with the session when the browser has authorised', async () => {
    fetchMock.mockImplementation(
      jsonResponse({
        status: 'complete',
        apiKey: 'fc-test-key',
        teamName: 'Acme',
      })
    );

    const result = await pollAuthStatus(SESSION_ID, CODE_VERIFIER, WEB_HOST);

    expect(result).toEqual({
      status: 'complete',
      session: {
        apiKey: 'fc-test-key',
        apiUrl: 'https://api.firecrawl.dev',
        teamName: 'Acme',
      },
    });
  });

  it('reports unreachable, with the underlying cause, when the transport fails', async () => {
    fetchMock.mockRejectedValue(
      transportFailure('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:443')
    );

    const result = await pollAuthStatus(SESSION_ID, CODE_VERIFIER, WEB_HOST);

    expect(result.status).toBe('unreachable');
    if (result.status !== 'unreachable')
      throw new Error('expected unreachable');
    expect(result.detail).toContain('connect ECONNREFUSED');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('separates a retryable rate limit from a refusal', async () => {
    fetchMock.mockImplementation(
      jsonResponse(
        { error: 'Too many requests. Please try again later.' },
        {
          status: 429,
        }
      )
    );
    await expect(
      pollAuthStatus(SESSION_ID, CODE_VERIFIER, WEB_HOST)
    ).resolves.toMatchObject({ status: 'server-busy' });

    fetchMock.mockImplementation(
      jsonResponse({ error: 'Session expired' }, { status: 410 })
    );
    await expect(
      pollAuthStatus(SESSION_ID, CODE_VERIFIER, WEB_HOST)
    ).resolves.toMatchObject({
      status: 'server-error',
      detail: 'HTTP 410: Session expired',
    });
  });
});

describe('waitForAuth', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Drives the poll loop without waiting on the real 2 second interval. */
  async function drain(ms = 60_000): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('surfaces an error naming the host instead of polling a dead transport to timeout', async () => {
    fetchMock.mockRejectedValue(
      transportFailure('ENOTFOUND', 'getaddrinfo ENOTFOUND test-host.example')
    );

    const pending = waitForAuth(SESSION_ID, CODE_VERIFIER, WEB_HOST);
    const assertion = expect(pending).rejects.toThrow(
      /Cannot reach test-host\.example/
    );
    await drain();
    await assertion;

    // It gave up on the transport rather than running the full 5 minute timeout.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('names the underlying cause and how to override the host', async () => {
    fetchMock.mockRejectedValue(
      transportFailure('ECONNRESET', 'CONNECT tunnel failed, response 403')
    );

    const pending = waitForAuth(SESSION_ID, CODE_VERIFIER, WEB_HOST);
    const assertion = expect(pending).rejects.toThrow(
      /CONNECT tunnel failed, response 403[\s\S]*--web-url/
    );
    await drain();
    await assertion;
  });

  it('keeps polling while the user has not authorised yet, then resolves', async () => {
    fetchMock
      .mockImplementationOnce(jsonResponse({ status: 'pending' }))
      .mockImplementationOnce(jsonResponse({ status: 'pending' }))
      .mockImplementationOnce(jsonResponse({ status: 'pending' }))
      .mockImplementationOnce(jsonResponse({ status: 'pending' }))
      .mockImplementation(
        jsonResponse({ status: 'complete', apiKey: 'fc-late-key' })
      );

    const pending = waitForAuth(SESSION_ID, CODE_VERIFIER, WEB_HOST);
    await drain();

    await expect(pending).resolves.toMatchObject({ apiKey: 'fc-late-key' });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(4);
  });

  it('still honours the existing timeout for a user who never authorises', async () => {
    fetchMock.mockImplementation(jsonResponse({ status: 'pending' }));

    const pending = waitForAuth(SESSION_ID, CODE_VERIFIER, WEB_HOST, 10_000);
    const assertion = expect(pending).rejects.toThrow(
      'Authentication timed out. Please try again.'
    );
    await drain();
    await assertion;
  });

  it('rides out a transient rate limit and completes', async () => {
    fetchMock
      .mockImplementationOnce(
        jsonResponse({ error: 'Too many requests.' }, { status: 429 })
      )
      .mockImplementationOnce(
        jsonResponse({ error: 'Too many requests.' }, { status: 429 })
      )
      .mockImplementation(
        jsonResponse({ status: 'complete', apiKey: 'fc-after-429' })
      );

    const pending = waitForAuth(SESSION_ID, CODE_VERIFIER, WEB_HOST);
    await drain();

    await expect(pending).resolves.toMatchObject({ apiKey: 'fc-after-429' });
  });

  it('counts each failure budget only while that failure repeats', async () => {
    // The transport budget is 3 and the server budget is 5. Five rounds of one
    // dead transport then one rate limit exhaust both if a counter survives the
    // other outcome, yet no failure of either kind ever repeats.
    const rounds: Array<() => Promise<Response>> = [];
    for (let round = 0; round < 5; round++) {
      rounds.push(() =>
        Promise.reject(transportFailure('ECONNRESET', 'socket hang up'))
      );
      rounds.push(
        jsonResponse({ error: 'Too many requests.' }, { status: 429 })
      );
    }
    const complete = jsonResponse({
      status: 'complete',
      apiKey: 'fc-after-mixed',
    });
    let call = 0;
    fetchMock.mockImplementation(() => (rounds[call++] ?? complete)());

    const pending = waitForAuth(SESSION_ID, CODE_VERIFIER, WEB_HOST);
    await drain();

    await expect(pending).resolves.toMatchObject({
      apiKey: 'fc-after-mixed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(rounds.length + 1);
  });

  it('stops at once when the server refuses the session', async () => {
    fetchMock.mockImplementation(
      jsonResponse({ error: 'Session expired' }, { status: 410 })
    );

    const pending = waitForAuth(SESSION_ID, CODE_VERIFIER, WEB_HOST);
    const assertion = expect(pending).rejects.toThrow(
      /rejected the login poll: HTTP 410: Session expired/
    );
    await drain();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('polls the status endpoint on the configured host', async () => {
    fetchMock.mockImplementation(
      jsonResponse({ status: 'complete', apiKey: 'fc-key' })
    );

    await waitForAuth(SESSION_ID, CODE_VERIFIER, WEB_HOST);

    expect(fetchMock).toHaveBeenCalledWith(
      STATUS_URL,
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('builds the same endpoint from the production default host', async () => {
    fetchMock.mockImplementation(
      jsonResponse({ status: 'complete', apiKey: 'fc-key' })
    );

    await waitForAuth(SESSION_ID, CODE_VERIFIER, WEB_URL);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.firecrawl.dev/api/auth/cli/status',
      expect.objectContaining({ method: 'POST' })
    );
  });
});

describe('default web URL', () => {
  it('defaults to www, which the apex redirects to and allowlists usually permit', () => {
    expect(WEB_URL).toBe('https://www.firecrawl.dev');
  });
});
