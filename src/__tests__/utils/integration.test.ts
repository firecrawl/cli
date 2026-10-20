/**
 * Tests for the X-Integration header
 */

import http from 'http';
import type { AddressInfo } from 'net';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { getClient, keylessRequest, resetClient } from '../../utils/client';
import { initializeConfig, resetConfig } from '../../utils/config';
import { integrationHeaders } from '../../utils/integration';

describe('integrationHeaders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends nothing when FIRECRAWL_INTEGRATION is unset or blank', () => {
    vi.stubEnv('FIRECRAWL_INTEGRATION', undefined);
    expect(integrationHeaders()).toEqual({});
    vi.stubEnv('FIRECRAWL_INTEGRATION', '   ');
    expect(integrationHeaders()).toEqual({});
  });

  it.each(['rtk', 'hermes', '_rtk', 'not a valid tag!'])(
    'sends %j as is, with no list to match',
    (value) => {
      vi.stubEnv('FIRECRAWL_INTEGRATION', value);
      expect(integrationHeaders()).toEqual({ 'X-Integration': value });
    }
  );

  it('trims surrounding whitespace', () => {
    vi.stubEnv('FIRECRAWL_INTEGRATION', '  hermes\n');
    expect(integrationHeaders()).toEqual({ 'X-Integration': 'hermes' });
  });

  it.each(['bad\nvalue', 'tag\u2713'])(
    'drops %j, which cannot be sent as a header',
    (value) => {
      vi.stubEnv('FIRECRAWL_INTEGRATION', value);
      expect(integrationHeaders()).toEqual({});
    }
  );
});

describe('X-Integration on the wire', () => {
  const received: http.IncomingHttpHeaders[] = [];
  let server: http.Server;
  let apiUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      received.push(req.headers);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: {} }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    received.length = 0;
    resetClient();
    resetConfig();
  });

  it.each(['rtk', 'hermes', '_rtk'])(
    'puts %j on SDK client requests while the body keeps integration cli',
    async (value) => {
      vi.stubEnv('FIRECRAWL_INTEGRATION', value);
      const client = getClient({ apiKey: 'fc-test', apiUrl });
      await (client as any).http.post('/v2/scrape', { integration: 'cli' });
      await (client as any).http.get('/v2/search/developer?integration=cli');
      expect(received.map((h) => h['x-integration'])).toEqual([value, value]);
    }
  );

  it('lets a request with a junk value succeed', async () => {
    vi.stubEnv('FIRECRAWL_INTEGRATION', 'not a valid tag!');
    initializeConfig({ apiUrl });
    await expect(
      keylessRequest('/v2/scrape', { url: 'https://example.com' })
    ).resolves.toEqual({ success: true, data: {} });
    expect(received[0]['x-integration']).toBe('not a valid tag!');
  });

  it('lets a request succeed without the header when the value cannot be sent', async () => {
    vi.stubEnv('FIRECRAWL_INTEGRATION', 'bad\nvalue');
    const client = getClient({ apiKey: 'fc-test', apiUrl });
    await expect(
      (client as any).http.post('/v2/scrape', { integration: 'cli' })
    ).resolves.toMatchObject({ status: 200 });
    expect(received[0]['x-integration']).toBeUndefined();
  });
});
