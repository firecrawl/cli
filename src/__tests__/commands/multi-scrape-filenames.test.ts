/**
 * Tests for where multi-URL scrape saves each page
 */

import * as fs from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMultiScrapeCommand } from '../../commands/scrape';
import { getClient } from '../../utils/client';

vi.mock('../../utils/client', () => ({
  getClient: vi.fn(),
  isKeylessMode: () => false,
  keylessRequest: vi.fn(),
}));
vi.mock('../../utils/interact-session', () => ({
  saveInteractSession: vi.fn(),
  clearInteractSession: vi.fn(),
}));
vi.mock('fs', async () => ({
  ...(await vi.importActual<typeof import('fs')>('fs')),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

describe('multi-URL scrape filenames', () => {
  beforeEach(() => {
    vi.mocked(getClient).mockReturnValue({
      scrape: vi.fn(async (url: string) => ({ markdown: `page ${url}` })),
    } as any);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('saves every URL to its own file when their names would collide', async () => {
    const urls = [
      'https://example.com/list?page=1',
      'https://example.com/list?page=2',
      'https://example.com/a/b',
      'https://example.com/a-b',
    ];

    await handleMultiScrapeCommand(urls, { url: urls[0] });

    const written = new Map(
      vi
        .mocked(fs.writeFileSync)
        .mock.calls.map(([file, content]) => [String(file), String(content)])
    );
    expect(written).toEqual(
      new Map([
        [
          join('.firecrawl', 'example.com-list.md'),
          'page https://example.com/list?page=1',
        ],
        [
          join('.firecrawl', 'example.com-list-2.md'),
          'page https://example.com/list?page=2',
        ],
        [
          join('.firecrawl', 'example.com-a-b.md'),
          'page https://example.com/a/b',
        ],
        [
          join('.firecrawl', 'example.com-a-b-2.md'),
          'page https://example.com/a-b',
        ],
      ])
    );
  });

  it('keeps the plain name for URLs that do not collide', async () => {
    const urls = ['https://example.com/', 'https://example.com/docs/intro'];

    await handleMultiScrapeCommand(urls, { url: urls[0] });

    const files = vi
      .mocked(fs.writeFileSync)
      .mock.calls.map(([file]) => String(file))
      .sort();
    expect(files).toEqual([
      join('.firecrawl', 'example.com-docs-intro.md'),
      join('.firecrawl', 'example.com.md'),
    ]);
  });
});
