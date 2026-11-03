/**
 * Tests for screenshot download warnings in handleAllScrapeCommand
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleAllScrapeCommand } from '../../commands/scrape';
import { executeMap } from '../../commands/map';
import { getClient, isKeylessMode } from '../../utils/client';
import { initializeConfig } from '../../utils/config';
import { setupTest, teardownTest } from '../utils/mock-client';

vi.mock('../../utils/client', async () => {
  const actual = await vi.importActual('../../utils/client');
  return {
    ...actual,
    getClient: vi.fn(),
    isKeylessMode: vi.fn(() => false),
    keylessRequest: vi.fn(),
  };
});

vi.mock('../../commands/map', () => ({ executeMap: vi.fn() }));
vi.mock('../../commands/status', () => ({
  getStatus: vi.fn(async () => ({})),
}));

describe('handleAllScrapeCommand screenshot download', () => {
  let tmpDir: string;
  let originalCwd: string;
  let stderr: string;

  beforeEach(() => {
    setupTest();
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrape-all-shot-'));
    process.chdir(tmpDir);

    vi.mocked(isKeylessMode).mockReturnValue(false);
    vi.mocked(executeMap).mockResolvedValue({
      success: true,
      data: { links: [{ url: 'https://example.com/page' }] },
    } as any);
    vi.mocked(getClient).mockReturnValue({
      scrape: vi.fn().mockResolvedValue({
        markdown: '# Page',
        screenshot: 'https://cdn.example.com/shot.png',
      }),
    } as any);

    stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
      stderr += String(chunk);
      return true;
    }) as any);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    teardownTest();
  });

  const run = () =>
    handleAllScrapeCommand(
      'https://example.com',
      { url: 'https://example.com', screenshot: true } as any,
      { yes: true }
    );

  it('warns when the screenshot download returns a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403 })
    );

    await run();

    expect(stderr).toContain(
      'Warning: could not download screenshot for https://example.com/page (HTTP 403)'
    );
  });

  it('warns when the screenshot download throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await run();

    expect(stderr).toContain(
      'Warning: could not download screenshot for https://example.com/page (network down)'
    );
  });
});
