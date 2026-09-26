import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClient, keylessRequest } from '../../utils/client';
import { initializeConfig } from '../../utils/config';
import { setupTest, teardownTest } from './mock-client';

vi.mock('../../utils/credentials', () => ({
  loadCredentials: vi.fn(() => null),
}));

describe('agent hints request opt-in', () => {
  let server: Server;
  let apiUrl: string;
  let requestHeaders: Array<Record<string, string | string[] | undefined>>;

  beforeEach(async () => {
    setupTest();
    requestHeaders = [];
    server = createServer((request, response) => {
      requestHeaders.push(request.headers);
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not bind to a TCP port');
    }
    apiUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    teardownTest();
  });

  it('opts in on authenticated SDK requests', async () => {
    const client = getClient({
      apiKey: 'fc-test',
      apiUrl,
      maxRetries: 1,
    });

    await (client as any).http.post('/v2/search', { query: 'test' });

    expect(requestHeaders).toHaveLength(1);
    expect(requestHeaders[0]['x-firecrawl-agent-hints']).toBe('true');
  });

  it('opts in on keyless requests', async () => {
    initializeConfig({ apiUrl });

    await keylessRequest('/v2/search', { query: 'test' });

    expect(requestHeaders).toHaveLength(1);
    expect(requestHeaders[0]['x-firecrawl-agent-hints']).toBe('true');
  });
});
