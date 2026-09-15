import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSearchCommand } from '../../commands/search';
import { handleScrapeCommand } from '../../commands/scrape';
import { handleMapCommand } from '../../commands/map';
import { handleParseCommand } from '../../commands/parse';
import { handleAlexandria } from '../../commands/alexandria';
import { getClient, isKeylessMode, keylessRequest } from '../../utils/client';
import { initializeConfig, resetConfig } from '../../utils/config';
import { agentHintMetadata } from '../../utils/agent-hints';

vi.mock('../../utils/client', async () => ({
  ...(await vi.importActual('../../utils/client')),
  getClient: vi.fn(),
  isKeylessMode: vi.fn(() => false),
  keylessRequest: vi.fn(),
}));

describe('server agent hints', () => {
  const hints = [
    'Inspect the returned tool definition.',
    'Submit feedback after evaluation.',
  ];
  let directory: string;
  let post: ReturnType<typeof vi.fn>;
  let scrape: ReturnType<typeof vi.fn>;
  let map: ReturnType<typeof vi.fn>;
  let stdout: string[];
  let stderr: string[];
  let priorExitCode: typeof process.exitCode;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'firecrawl-hints-'));
    stdout = [];
    stderr = [];
    priorExitCode = process.exitCode;
    post = vi.fn();
    scrape = vi.fn();
    map = vi.fn();
    vi.mocked(getClient).mockReturnValue({
      http: { post },
      scrape,
      map,
    } as any);
    vi.mocked(isKeylessMode).mockReturnValue(false);
    initializeConfig({
      apiKey: 'fc-test',
      apiUrl: 'https://api.firecrawl.dev',
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      stderr.push(args.join(' '));
    });
  });

  afterEach(() => {
    process.exitCode = priorExitCode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    resetConfig();
    rmSync(directory, { recursive: true, force: true });
  });

  it('preserves empty search results, feedback identity and hints in JSON', async () => {
    const envelope = {
      success: true,
      data: { web: [] },
      id: 'search-1',
      creditsUsed: 0,
      agent_hints: hints,
    };
    post.mockResolvedValue({ data: envelope });
    await handleSearchCommand({ query: 'example', json: true });
    expect(JSON.parse(stdout.join(''))).toEqual(envelope);
    expect(stderr).toEqual([]);
  });

  it('keeps search hints out of readable results and output files', async () => {
    post.mockResolvedValue({
      data: {
        success: true,
        data: { web: [{ url: 'https://example.com', title: 'Example' }] },
        agent_hints: hints,
      },
    });
    const output = join(directory, 'search.txt');
    await handleSearchCommand({ query: 'example', output });
    expect(readFileSync(output, 'utf8')).toContain('Example');
    expect(readFileSync(output, 'utf8')).not.toContain(hints[0]);
    expect(stderr.join('')).toContain(hints[0]);
    expect(stdout).toEqual([]);
  });

  it('returns JSON on typed search failure with its hints and identity', async () => {
    const failure = {
      success: false,
      error: 'Invalid source',
      code: 'INVALID_BODY',
      id: 'search-2',
      agent_hints: hints,
    };
    post.mockRejectedValue(
      Object.assign(new Error('Invalid source'), {
        response: { data: failure },
      })
    );
    await handleSearchCommand({ query: 'example', json: true });
    expect(JSON.parse(stdout.join(''))).toEqual(failure);
    expect(process.exitCode).toBe(1);
  });

  it('can suppress hints in JSON without adding a server request option', async () => {
    post.mockResolvedValue({
      data: { success: true, data: { web: [] }, agent_hints: hints },
    });
    await handleSearchCommand({
      query: 'example',
      json: true,
      agentHints: false,
    });
    expect(JSON.parse(stdout.join(''))).toEqual({
      success: true,
      data: { web: [] },
    });
    expect(post.mock.calls[0][1]).not.toHaveProperty('agentHints');
    expect(stderr).toEqual([]);
  });

  it('leaves ordinary scrape content unchanged when no hints are returned', async () => {
    scrape.mockResolvedValue({ markdown: '# Page' });
    await handleScrapeCommand({ url: 'https://example.com' });
    expect(stdout.join('')).toBe('# Page\n');
    expect(stderr).toEqual([]);
  });

  it('retains SDK hints in flattened scrape JSON and multiple-format JSON', async () => {
    scrape.mockResolvedValue({
      markdown: '# Page',
      links: ['https://example.com'],
      agent_hints: hints,
    });
    await handleScrapeCommand({
      url: 'https://example.com',
      formats: ['markdown', 'links'],
    });
    expect(JSON.parse(stdout.join(''))).toEqual({
      markdown: '# Page',
      links: ['https://example.com'],
      agent_hints: hints,
    });
    expect(stderr).toEqual([]);
  });

  it('preserves keyless envelope hints while writing only page text to a raw file', async () => {
    vi.mocked(isKeylessMode).mockReturnValue(true);
    vi.mocked(keylessRequest).mockResolvedValue({
      success: true,
      data: { markdown: '# Page' },
      agent_hints: hints,
    });
    const output = join(directory, 'page.md');
    await handleScrapeCommand({ url: 'https://example.com', output });
    expect(readFileSync(output, 'utf8')).toBe('# Page');
    expect(stderr.join('')).toContain(hints[0]);
  });

  it('honors hint suppression for SDK scrape results and query output', async () => {
    scrape.mockResolvedValue({ answer: '42', agent_hints: hints });
    await handleScrapeCommand({
      url: 'https://example.com',
      query: 'How many?',
      agentHints: false,
    });
    expect(stdout.join('')).toBe('42\n');
    expect(stderr).toEqual([]);
  });

  it('preserves a keyless failure envelope even when HTTP succeeded', async () => {
    vi.mocked(isKeylessMode).mockReturnValue(true);
    const failure = {
      success: false,
      error: 'Scrape failed',
      code: 'SCRAPE_FAILED',
      agent_hints: hints,
    };
    vi.mocked(keylessRequest).mockResolvedValue(failure);
    await handleScrapeCommand({ url: 'https://example.com', json: true });
    expect(JSON.parse(stdout.join(''))).toEqual(failure);
    expect(process.exitCode).toBe(1);
  });

  it('keeps query-mode metadata when JSON was explicitly requested', async () => {
    scrape.mockResolvedValue({ answer: '42', agent_hints: hints });
    await handleScrapeCommand({
      url: 'https://example.com',
      query: 'How many?',
      json: true,
    });
    expect(JSON.parse(stdout.join(''))).toEqual({
      answer: '42',
      agent_hints: hints,
    });
  });

  it('retains error hints exposed by the SDK and returns a failing exit code', async () => {
    scrape.mockRejectedValue(
      Object.assign(new Error('Request failed'), { agent_hints: hints })
    );
    await handleScrapeCommand({ url: 'https://example.com', json: true });
    expect(JSON.parse(stdout.join(''))).toEqual({
      success: false,
      error: 'Request failed',
      agent_hints: hints,
    });
    expect(process.exitCode).toBe(1);
  });

  it('preserves map hints with an empty link list', async () => {
    map.mockResolvedValue({ id: 'map-1', links: [], agent_hints: hints });
    await handleMapCommand({ urlOrJobId: 'https://example.com', json: true });
    expect(JSON.parse(stdout.join(''))).toEqual({
      success: true,
      id: 'map-1',
      data: { links: [] },
      agent_hints: hints,
    });
  });

  it.each([true, false])(
    'preserves parse hints on success=%s',
    async (success) => {
      const file = join(directory, 'page.html');
      writeFileSync(file, '<h1>Page</h1>');
      const envelope = success
        ? { success, data: { markdown: '# Page' }, agent_hints: hints }
        : { success, error: 'Parse failed', agent_hints: hints };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: success,
          status: success ? 200 : 400,
          json: async () => envelope,
        })
      );
      await handleParseCommand({ file, json: true });
      expect(JSON.parse(stdout.join(''))).toEqual(
        success ? { markdown: '# Page', agent_hints: hints } : envelope
      );
    }
  );

  it('preserves Alexandria receipt, partial results and SDK hints', async () => {
    const alexandria = [
      { provider: 'example', capability: 'lookup', error: { code: 'FAILED' } },
    ];
    scrape.mockResolvedValue({
      alexandria,
      creditsCost: 1,
      scrapeId: 'scrape-3',
      agent_hints: hints,
    });
    await handleAlexandria(
      [{ provider: 'example', capability: 'lookup', options: {} }],
      { requestId: 'retry-1' }
    );
    expect(JSON.parse(stdout.join(''))).toEqual({
      success: true,
      scrape_id: 'scrape-3',
      data: { alexandria, creditsCost: 1 },
      requestId: 'retry-1',
      agent_hints: hints,
    });
    expect(process.exitCode).toBe(1);
  });

  it('accepts only string hints and caps malformed upstream arrays at three', () => {
    expect(
      agentHintMetadata({ agent_hints: ['one', null, 'two', 'three', 'four'] })
    ).toEqual({ agent_hints: ['one', 'two', 'three'] });
    expect(agentHintMetadata({ agent_hints: 'not an array' })).toEqual({});
    expect(agentHintMetadata({})).toEqual({});
  });
});
