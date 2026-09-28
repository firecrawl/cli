/**
 * Tests for parse command
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeParse } from '../../commands/parse';
import { initializeConfig } from '../../utils/config';
import { setupTest, teardownTest } from '../utils/mock-client';

vi.mock('../../utils/credentials', () => ({
  loadCredentials: vi.fn(() => null),
}));

describe('executeParse', () => {
  let tmpDir: string;
  let filePath: string;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setupTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-parse-test-'));
    filePath = path.join(tmpDir, 'page.html');
    fs.writeFileSync(filePath, '<html><body>Test</body></html>');

    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        success: true,
        data: { markdown: '# Test' },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    teardownTest();
    vi.clearAllMocks();
  });

  it('posts to /v2/parse without auth when using the default cloud API with no key', async () => {
    initializeConfig({ apiUrl: 'https://api.firecrawl.dev///' });

    const result = await executeParse({ file: filePath });

    expect(result).toEqual({
      success: true,
      data: { markdown: '# Test' },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0] as [
      string,
      { method: string; headers?: Record<string, string>; body: FormData },
    ];
    expect(url).toBe('https://api.firecrawl.dev/v2/parse');
    expect(init.method).toBe('POST');
    expect(init.headers).toBeUndefined();

    const options = JSON.parse(init.body.get('options') as string);
    expect(options).toEqual({
      formats: ['markdown'],
      integration: 'cli',
    });
    expect(init.body.get('file')).toBeInstanceOf(Blob);
  });

  it('includes the bearer token when an API key is configured', async () => {
    initializeConfig({
      apiKey: 'fc-test-key',
      apiUrl: 'https://api.firecrawl.dev',
    });

    await executeParse({ file: filePath });

    const [, init] = mockFetch.mock.calls[0] as [
      string,
      { headers?: Record<string, string> },
    ];
    expect(init.headers).toEqual({
      Authorization: 'Bearer fc-test-key',
    });
  });
});
