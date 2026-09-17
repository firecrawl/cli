import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMultiScrapeCommand } from '../../commands/scrape';
import { getClient } from '../../utils/client';
import { clearInteractSession } from '../../utils/interact-session';

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
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const urls = ['https://example.com/a', 'https://example.com/b'];
const documents = urls.map((url, index) => ({
  markdown: `Page ${index}`,
  html: `<p>Page ${index}</p>`,
  metadata: { sourceURL: url, creditsUsed: index + 1, scrapeId: `id-${index}` },
}));

describe('multi-URL scrape output', () => {
  const scrape = vi.fn();
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
    scrape.mockReset();
    vi.mocked(getClient).mockReturnValue({ scrape } as any);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('writes one ordered collection to the requested path despite out-of-order completion', async () => {
    let resolveFirst!: (value: unknown) => void;
    scrape.mockImplementation(async (url) => {
      if (url === urls[0])
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      setImmediate(() => resolveFirst(documents[0]));
      return documents[1];
    });
    await handleMultiScrapeCommand(urls, {
      url: urls[0],
      output: 'out/results.txt',
      pretty: true,
    });
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [path, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(path).toBe('out/results.txt');
    expect(content).toBe(
      JSON.stringify(
        documents.map((data, index) => ({
          url: urls[index],
          success: true,
          data,
          receipt: {
            creditsUsed: index + 1,
            operationId: `id-${index}`,
            operationType: 'scrape',
          },
        })),
        null,
        2
      )
    );
    expect(fs.mkdirSync).not.toHaveBeenCalledWith(
      '.firecrawl',
      expect.anything()
    );
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(clearInteractSession).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it('prints valid JSON with full metadata on stdout without per-URL files', async () => {
    scrape
      .mockResolvedValueOnce(documents[0])
      .mockResolvedValueOnce(documents[1]);
    await handleMultiScrapeCommand(urls, { url: urls[0], json: true });
    expect(process.stdout.write).toHaveBeenCalledTimes(1);
    const output = JSON.parse(
      String(vi.mocked(process.stdout.write).mock.calls[0][0])
    );
    expect(output.map((item: any) => item.data)).toEqual(documents);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves errors and successful results with failure exit status (all failed: %s)',
    async (allFailed) => {
      if (allFailed) scrape.mockRejectedValueOnce(new Error('First failed'));
      else scrape.mockResolvedValueOnce(documents[0]);
      scrape.mockRejectedValueOnce(new Error('Second failed'));
      await handleMultiScrapeCommand(urls, {
        url: urls[0],
        json: true,
        output: 'results.json',
      });
      const output = JSON.parse(
        String(vi.mocked(fs.writeFileSync).mock.calls[0][1])
      );
      expect(output).toEqual([
        allFailed
          ? { url: urls[0], success: false, error: 'First failed', receipt: {} }
          : {
              url: urls[0],
              success: true,
              data: documents[0],
              receipt: {
                operationId: 'id-0',
                operationType: 'scrape',
                creditsUsed: 1,
              },
            },
        { url: urls[1], success: false, error: 'Second failed', receipt: {} },
      ]);
      expect(process.exitCode).toBe(1);
      expect(process.stdout.write).not.toHaveBeenCalled();
    }
  );

  it('keeps default per-file behavior and reports partial failure', async () => {
    scrape
      .mockResolvedValueOnce(documents[0])
      .mockRejectedValueOnce(new Error('Second failed'));
    await handleMultiScrapeCommand(urls, { url: urls[0] });
    expect(fs.mkdirSync).toHaveBeenCalledWith('.firecrawl', {
      recursive: true,
    });
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '.firecrawl/example.com-a.md',
      'Page 0',
      'utf-8'
    );
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
