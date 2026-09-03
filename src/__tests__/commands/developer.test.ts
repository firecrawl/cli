/**
 * Tests for developer command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleDeveloperSearchCommand } from '../../commands/developer';
import { getClient } from '../../utils/client';
import { initializeConfig } from '../../utils/config';
import { writeOutput } from '../../utils/output';
import { setupTest, teardownTest } from '../utils/mock-client';

vi.mock('../../utils/output', () => ({ writeOutput: vi.fn() }));

vi.mock('../../utils/client', async () => {
  const actual = await vi.importActual('../../utils/client');
  return {
    ...actual,
    getClient: vi.fn(),
  };
});

describe('handleDeveloperSearchCommand', () => {
  let mockHttpGet: ReturnType<typeof vi.fn>;

  // Wrap a payload in the axios envelope returned by `client.http.get`.
  const mockDeveloperResponse = (results: any[], extra = {}) => ({
    data: { success: true, results, ...extra },
  });

  const sampleResult = {
    id: 'issue:tokio-rs/tokio#2309',
    url: 'https://github.com/tokio-rs/tokio/issues/2309',
    title: 'spawn_blocking panics when exceeding the thread limit',
    passages: [
      {
        text: 'It will panic if this limit is too low.',
        citation_url:
          'https://github.com/tokio-rs/tokio/issues/2309#issuecomment-1',
      },
    ],
    license: { state: 'licensed', spdx_id: 'MIT' },
  };

  beforeEach(() => {
    setupTest();
    initializeConfig({
      apiKey: 'test-api-key',
      apiUrl: 'https://api.firecrawl.dev',
    });

    mockHttpGet = vi.fn();
    vi.mocked(getClient).mockReturnValue({
      http: { get: mockHttpGet },
    } as any);
  });

  afterEach(() => {
    teardownTest();
    vi.clearAllMocks();
  });

  describe('API call generation', () => {
    it('calls /v2/search/developer without a client passage budget', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([sampleResult]));

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      expect(mockHttpGet).toHaveBeenCalledTimes(1);
      expect(mockHttpGet).toHaveBeenCalledWith(
        '/v2/search/developer?query=tokio+spawn_blocking&integration=cli'
      );
    });

    it('passes k when a result count is provided', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([sampleResult]));

      await handleDeveloperSearchCommand({
        query: 'tokio spawn_blocking',
        k: 5,
      });

      expect(mockHttpGet).toHaveBeenCalledWith(
        '/v2/search/developer?query=tokio+spawn_blocking&k=5&integration=cli'
      );
    });

    it('passes apiUrl and apiKey to getClient when provided', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([]));

      await handleDeveloperSearchCommand({
        query: 'test',
        apiKey: 'other-key',
        apiUrl: 'http://localhost:3002',
      });

      expect(getClient).toHaveBeenCalledWith({
        apiKey: 'other-key',
        apiUrl: 'http://localhost:3002',
      });
    });
  });

  describe('output', () => {
    it('renders id, type, title, url, and passage in readable output', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([sampleResult]));

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0];
      expect(content).toContain(
        '## [issue:tokio-rs/tokio#2309] (issue) spawn_blocking panics when exceeding the thread limit'
      );
      expect(content).toContain(
        'https://github.com/tokio-rs/tokio/issues/2309'
      );
      expect(content).toContain('It will panic if this limit is too low.');
    });

    it('renders full passages, citations, licenses, and indexing echoes', async () => {
      const passage = 'x'.repeat(5000);
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse(
          [{ ...sampleResult, passages: [{ text: passage }], license: 'MIT' }],
          {
            repos: [
              {
                repo: 'tokio-rs/tokio',
                indexed: true,
                types: { issue: true, pullRequest: true, readme: false },
              },
            ],
            sources: [{ source: 'rust', indexed: false }],
          }
        )
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      expect(content).toContain(passage);
      expect(content).toContain('License: MIT');
      expect(content).toContain('tokio-rs/tokio: indexed');
      expect(content).toContain('rust: not indexed');
    });

    it('collapses blank runs and caps each passage at 40 rendered lines', async () => {
      const passage = [
        'First line.  ',
        '',
        '',
        '',
        ...Array.from({ length: 50 }, (_, index) => `Line ${index + 2}`),
      ].join('\n');
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          {
            ...sampleResult,
            passages: [
              {
                text: passage,
                citation_url: 'https://example.com/citation',
              },
            ],
          },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      expect(content).not.toContain('First line.  ');
      expect(content).not.toContain('\n\n\n');
      expect(content).toContain(
        '… (14 more lines; use --json for the full passage)'
      );
      expect(content).not.toContain('Line 39\n');
      expect(content).toContain('Citation: https://example.com/citation');
      const passageBlock = content.split('\n').slice(3);
      expect(passageBlock).toHaveLength(40);
    });

    it('keeps citation line breaks inside the passage line budget', async () => {
      const passage = Array.from(
        { length: 50 },
        (_, index) => `Line ${index + 1}`
      ).join('\n');
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          {
            ...sampleResult,
            passages: [
              {
                text: passage,
                citation_url: 'https://example.com/one\r\ntwo\nthree',
              },
            ],
          },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const passageBlock = content.split('\n').slice(3);
      expect(passageBlock).toHaveLength(40);
      expect(passageBlock.at(-2)).toBe(
        '… (12 more lines; use --json for the full passage)'
      );
      expect(passageBlock.at(-1)).toBe(
        'Citation: https://example.com/one two three'
      );
    });

    it('normalizes and caps passages with lone carriage-return lines', async () => {
      const passage = Array.from(
        { length: 50 },
        (_, index) => `Line ${index + 1}  `
      ).join('\r');
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          { ...sampleResult, passages: [{ text: passage }] },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const passageBlock = content.split('\n').slice(3);
      expect(passageBlock).toHaveLength(40);
      expect(passageBlock[0]).toBe('Line 1');
      expect(passageBlock.at(-1)).toBe(
        '… (11 more lines; use --json for the full passage)'
      );
    });

    it('keeps a long fenced passage balanced within the line cap', async () => {
      const passage = [
        '```rust',
        ...Array.from(
          { length: 50 },
          (_, index) => `let value_${index} = ${index};`
        ),
        '```',
      ].join('\n');
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          { ...sampleResult, passages: [{ text: passage }] },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const passageBlock = content.split('\n').slice(3);
      expect(passageBlock).toHaveLength(40);
      expect(passageBlock.filter((line) => line === '```')).toHaveLength(1);
      expect(passageBlock.at(-2)).toBe('```');
      expect(passageBlock.at(-1)).toContain('use --json');
    });

    it.each([
      {
        name: 'block quote',
        passage: [
          '> ```rust',
          ...Array.from({ length: 50 }, (_, index) => `> let value_${index};`),
          '> ```',
        ].join('\n'),
        close: '> ```',
      },
      {
        name: 'list item',
        passage: [
          '- ```rust',
          ...Array.from({ length: 50 }, (_, index) => `  let value_${index};`),
          '  ```',
        ].join('\n'),
        close: '  ```',
      },
    ])('keeps a long $name fence balanced', async ({ passage, close }) => {
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          { ...sampleResult, passages: [{ text: passage }] },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const passageBlock = content.split('\n').slice(3);
      expect(passageBlock).toHaveLength(40);
      expect(passageBlock.at(-2)).toBe(close);
      expect(passageBlock.at(-1)).toContain('use --json');
    });

    it('expands tab-padded list indentation for a synthetic closer', async () => {
      const passage = [
        '-\t```text',
        ...Array.from({ length: 50 }, (_, index) => `    code ${index}`),
      ].join('\n');
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          { ...sampleResult, passages: [{ text: passage }] },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const passageBlock = content.split('\n').slice(3);
      expect(passageBlock).toHaveLength(40);
      expect(passageBlock.at(-2)).toBe('    ```');
      expect(passageBlock.at(-1)).toContain('use --json');
    });

    it('matches a tab-padded list opener to a column-indented closer', async () => {
      const passage = [
        '-\t```text',
        ...Array.from({ length: 10 }, (_, index) => `    code ${index}`),
        '    ```',
        ...Array.from({ length: 40 }, (_, index) => `prose ${index}`),
      ].join('\n');
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          { ...sampleResult, passages: [{ text: passage }] },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const passageBlock = content.split('\n').slice(3);
      expect(passageBlock).toHaveLength(40);
      expect(passageBlock.filter((line) => line === '    ```')).toHaveLength(1);
      expect(passageBlock).toContain('prose 26');
    });

    it('accepts valid closing-fence indentation that differs from the opener', async () => {
      const passage = [
        ' ```text',
        ...Array.from({ length: 10 }, (_, index) => `code ${index}`),
        '  ```',
        ...Array.from({ length: 40 }, (_, index) => `prose ${index}`),
      ].join('\n');
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          { ...sampleResult, passages: [{ text: passage }] },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const passageBlock = content.split('\n').slice(3);
      expect(passageBlock.filter((line) => line.trim() === '```')).toHaveLength(
        1
      );
      expect(passageBlock).toContain('prose 26');
      expect(passageBlock.at(-1)).toContain('use --json');
    });

    it('preserves matching indentation on a synthetic closing fence', async () => {
      const passage = [
        '  ```text',
        ...Array.from({ length: 50 }, (_, index) => `  code ${index}`),
        '  ```',
      ].join('\n');
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          { ...sampleResult, passages: [{ text: passage }] },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const passageBlock = content.split('\n').slice(3);
      expect(passageBlock[0]).toBe('  ```text');
      expect(passageBlock.at(-2)).toBe('  ```');
    });

    it('accepts a blockquote closer with different optional spacing', async () => {
      const passage = [
        '> ```text',
        ...Array.from({ length: 10 }, (_, index) => `> code ${index}`),
        '>```',
        ...Array.from({ length: 40 }, (_, index) => `prose ${index}`),
      ].join('\n');
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          { ...sampleResult, passages: [{ text: passage }] },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const passageBlock = content.split('\n').slice(3);
      expect(
        passageBlock.filter((line) => line.trim() === '>```')
      ).toHaveLength(1);
      expect(passageBlock).toContain('prose 26');
    });

    it('does not parse a ten-digit ordered marker as a list container', async () => {
      const passage = [
        '1234567890. ```text',
        ...Array.from({ length: 50 }, (_, index) => `prose ${index}`),
      ].join('\n');
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          { ...sampleResult, passages: [{ text: passage }] },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const passageBlock = content.split('\n').slice(3);
      expect(passageBlock).toHaveLength(40);
      expect(passageBlock.filter((line) => line.trim() === '```')).toHaveLength(
        0
      );
      expect(passageBlock.at(-1)).toContain('use --json');
    });

    it('does not treat non-Markdown whitespace as a fence closer', async () => {
      const passage = [
        '```text',
        'code before invalid closer',
        '```\v',
        ...Array.from({ length: 50 }, (_, index) => `code ${index}`),
        '```',
      ].join('\n');
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          { ...sampleResult, passages: [{ text: passage }] },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const passageBlock = content.split('\n').slice(3);
      expect(passageBlock).toHaveLength(40);
      expect(passageBlock.at(-2)).toBe('```');
      expect(passageBlock.at(-1)).toContain('use --json');
    });

    it('does not close a quoted fence on list-prefixed code content', async () => {
      const passage = [
        '> ```text',
        ...Array.from({ length: 10 }, (_, index) => `> code ${index}`),
        '> - ```',
        ...Array.from({ length: 40 }, (_, index) => `> more code ${index}`),
        '> ```',
      ].join('\n');
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          { ...sampleResult, passages: [{ text: passage }] },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const passageBlock = content.split('\n').slice(3);
      expect(passageBlock).toContain('> - ```');
      expect(passageBlock.at(-2)).toBe('> ```');
      expect(passageBlock.at(-1)).toContain('use --json');
    });

    it('renders every passage without a passage-count cap', async () => {
      const passages = Array.from({ length: 45 }, (_, index) => ({
        text: `unique passage ${index + 1}`,
      }));
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([{ ...sampleResult, passages }])
      );

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      for (const passage of passages) expect(content).toContain(passage.text);
      expect(content.split('\n---\n')).toHaveLength(45);
    });

    it('prints a result URL only when its id does not contain it', async () => {
      const duplicateUrl = 'https://docs.rs/tokio/latest/tokio';
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          sampleResult,
          {
            id: `web:${duplicateUrl}`,
            url: duplicateUrl,
            title: 'Tokio docs',
            passages: [{ text: 'Runtime documentation.' }],
          },
          {
            id: `web:${duplicateUrl}/search`,
            url: duplicateUrl,
            title: 'Tokio search',
            passages: [{ text: 'Search documentation.' }],
          },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio runtime' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      expect(content.split(duplicateUrl).length - 1).toBe(3);
      expect(content).toContain(
        `## [web:${duplicateUrl}/search] Tokio search\n${duplicateUrl}\n`
      );
      expect(content).toContain(
        '\nhttps://github.com/tokio-rs/tokio/issues/2309\n'
      );
    });

    it('does not render separators for empty passages', async () => {
      mockHttpGet.mockResolvedValue(
        mockDeveloperResponse([
          {
            ...sampleResult,
            passages: [
              { text: '' },
              { text: ' ' },
              { text: 'The answer.' },
              {},
            ],
          },
        ])
      );

      await handleDeveloperSearchCommand({ query: 'tokio runtime' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      expect(content).toContain('\nThe answer.');
      expect(content).not.toContain('---');
    });

    it('renders citation URLs and object license disclosures', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([sampleResult]));

      await handleDeveloperSearchCommand({ query: 'tokio spawn_blocking' });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      expect(content).toContain('License: MIT');
      expect(content).toContain(
        'Citation: https://github.com/tokio-rs/tokio/issues/2309#issuecomment-1'
      );
    });

    it('prints a placeholder when there are no results', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([]));

      await handleDeveloperSearchCommand({ query: 'no hits' });

      const [content] = vi.mocked(writeOutput).mock.calls[0];
      expect(content).toBe('(no results)');
    });

    it('tolerates a success response that omits results', async () => {
      mockHttpGet.mockResolvedValue({ data: { success: true } });

      await handleDeveloperSearchCommand({ query: 'no result field' });

      const [content] = vi.mocked(writeOutput).mock.calls[0];
      expect(content).toBe('(no results)');
    });

    it('outputs the full envelope as JSON with --json', async () => {
      mockHttpGet.mockResolvedValue(mockDeveloperResponse([sampleResult]));

      await handleDeveloperSearchCommand({
        query: 'tokio spawn_blocking',
        json: true,
      });

      const [content] = vi.mocked(writeOutput).mock.calls[0] as [string];
      const parsed = JSON.parse(content);
      expect(parsed.results[0].passages[0].text).toBe(
        'It will panic if this limit is too low.'
      );
    });
  });

  describe('error handling', () => {
    it('exits with code 1 when the request fails', async () => {
      mockHttpGet.mockRejectedValue(new Error('boom'));
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as any);
      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await handleDeveloperSearchCommand({ query: 'test' });

      expect(errorSpy).toHaveBeenCalledWith('Error:', 'boom');
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });
});
