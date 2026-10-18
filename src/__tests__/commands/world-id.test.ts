/**
 * Tests for World ID verification (device flow) and the keyless header.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-world-id-'));

vi.mock('../../utils/credentials', () => ({
  getConfigDirectoryPath: () => configDir,
  loadCredentials: () => null,
}));
vi.mock('../../utils/auth', () => ({ openBrowser: vi.fn(async () => {}) }));

import {
  verifyWorldId,
  WORLD_ID_UNAVAILABLE_MESSAGE,
} from '../../commands/world-id';
import { keylessGet, keylessRequest } from '../../utils/client';
import {
  activeWorldIdCredential,
  clearWorldIdCredential,
  loadWorldIdCredential,
  saveWorldIdCredential,
} from '../../utils/world-id';

const CREDENTIAL = 'fcwid_payload.signature';
const START = {
  success: true,
  device_handle: 'handle-1',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://world.example/device',
  expires_in: 1200,
  interval: 5,
};

function stubResponses(...responses: Array<[number, unknown]>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const [status, body] = responses.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const quiet = { log: () => {}, sleep: async () => {}, openBrowser: false };

describe('firecrawl world-id', () => {
  beforeEach(() => {
    clearWorldIdCredential();
    delete process.env.FIRECRAWL_WORLD_ID;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs the device flow and stores the credential', async () => {
    const fetchMock = stubResponses(
      [200, START],
      [400, { success: false, error: 'authorization_pending' }],
      [
        200,
        {
          success: true,
          credential: CREDENTIAL,
          expires_at: '2099-01-01T00:00:00.000Z',
        },
      ]
    );

    const stored = await verifyWorldId(quiet);

    expect(stored).toEqual({
      credential: CREDENTIAL,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(loadWorldIdCredential()).toEqual(stored);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.firecrawl.dev/v2/keyless/world-id/device',
      'https://api.firecrawl.dev/v2/keyless/world-id/token',
      'https://api.firecrawl.dev/v2/keyless/world-id/token',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      device_handle: 'handle-1',
    });
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<
      string,
      string
    >;
    expect(headers['X-Origin']).toBe('cli');
    expect(headers.Authorization).toBeUndefined();
  });

  it('says so when the API has World ID turned off', async () => {
    stubResponses([404, { success: false, error: 'Not found' }]);

    await expect(verifyWorldId(quiet)).rejects.toThrow(
      WORLD_ID_UNAVAILABLE_MESSAGE
    );
    expect(loadWorldIdCredential()).toBeNull();
  });

  it('slows down when asked and stops on a declined approval', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    stubResponses(
      [200, START],
      [400, { success: false, error: 'slow_down' }],
      [400, { success: false, error: 'access_denied' }]
    );

    await expect(verifyWorldId({ ...quiet, sleep })).rejects.toThrow(
      'World ID verification was declined.'
    );
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 10000]);
  });

  it('reports a World ID that is not on the allowlist', async () => {
    stubResponses(
      [200, START],
      [
        403,
        {
          success: false,
          error: 'subject_not_allowed',
          subject_hash: 'h'.repeat(43),
        },
      ]
    );

    await expect(verifyWorldId(quiet)).rejects.toThrow('h'.repeat(43));
  });

  it('gives up when the code expires', async () => {
    let clock = 0;
    stubResponses(
      [200, { ...START, expires_in: 10 }],
      [400, { success: false, error: 'authorization_pending' }],
      [400, { success: false, error: 'authorization_pending' }]
    );

    await expect(
      verifyWorldId({
        ...quiet,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
      })
    ).rejects.toThrow('The World ID code expired');
  });

  it('sends the stored credential on keyless requests only while unexpired', async () => {
    const fetchMock = stubResponses(
      [200, { success: true }],
      [200, { success: true }]
    );
    saveWorldIdCredential({
      credential: CREDENTIAL,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    await keylessRequest('/v2/scrape', { url: 'https://example.com' });
    await keylessGet('/v2/research/search?q=test');

    for (const [, init] of fetchMock.mock.calls) {
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-firecrawl-world-id']).toBe(CREDENTIAL);
      expect(headers.Authorization).toBeUndefined();
    }

    saveWorldIdCredential({
      credential: CREDENTIAL,
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(activeWorldIdCredential()).toBeUndefined();
  });

  it('prefers FIRECRAWL_WORLD_ID over the stored credential', () => {
    saveWorldIdCredential({
      credential: CREDENTIAL,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    process.env.FIRECRAWL_WORLD_ID = 'fcwid_from.env';

    expect(activeWorldIdCredential()).toBe('fcwid_from.env');
  });

  it('stores the credential readable by the owner only', () => {
    saveWorldIdCredential({
      credential: CREDENTIAL,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const mode =
      fs.statSync(path.join(configDir, 'world-id.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
