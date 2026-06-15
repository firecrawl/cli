/**
 * Tests for output utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { writeOutput, handleScrapeOutput } from '../../utils/output';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('Output Utilities', () => {
  let consoleErrorSpy: any;
  let processExitSpy: any;
  let stdoutWriteSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('writeOutput', () => {
    it('should write content to stdout when no output path is provided', () => {
      writeOutput('Test content');

      expect(stdoutWriteSpy).toHaveBeenCalledWith('Test content\n');
    });

    it('should add newline to content if not present', () => {
      writeOutput('Test content without newline');

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        'Test content without newline\n'
      );
    });

    it('should not add extra newline if content already ends with newline', () => {
      writeOutput('Test content with newline\n');

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        'Test content with newline\n'
      );
    });

    it('should write content to file when output path is provided', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      writeOutput('Test content', '/output/test.txt');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/output/test.txt',
        'Test content',
        'utf-8'
      );
    });

    it('should create directory if it does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      writeOutput('Test content', '/output/subdir/test.txt');

      expect(fs.mkdirSync).toHaveBeenCalledWith('/output/subdir', {
        recursive: true,
      });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/output/subdir/test.txt',
        'Test content',
        'utf-8'
      );
    });

    it('should print file confirmation when not silent', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      writeOutput('Test content', '/output/test.txt', false);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Output written to: /output/test.txt'
      );
    });

    it('should not print file confirmation when silent', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      writeOutput('Test content', '/output/test.txt', true);

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('handleScrapeOutput', () => {
    it('should output error and exit when result is not successful', () => {
      handleScrapeOutput({ success: false, error: 'API Error' }, ['markdown']);

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error:', 'API Error');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should output raw markdown for single markdown format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: { markdown: '# Test Content\n\nParagraph here.' },
        },
        ['markdown']
      );

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        '# Test Content\n\nParagraph here.\n'
      );
    });

    it('should output raw HTML for single html format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: { html: '<html><body>Test</body></html>' },
        },
        ['html']
      );

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        '<html><body>Test</body></html>\n'
      );
    });

    it('should output raw HTML for single rawHtml format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: { rawHtml: '<!DOCTYPE html><html><body>Raw</body></html>' },
        },
        ['rawHtml']
      );

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        '<!DOCTYPE html><html><body>Raw</body></html>\n'
      );
    });

    it('should output newline-separated links for single links format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: {
            links: [
              'https://example.com/1',
              'https://example.com/2',
              'https://example.com/3',
            ],
          },
        },
        ['links']
      );

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        'https://example.com/1\nhttps://example.com/2\nhttps://example.com/3\n'
      );
    });

    it('should output newline-separated images for single images format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: {
            images: [
              'https://example.com/img1.jpg',
              'https://example.com/img2.png',
            ],
          },
        },
        ['images']
      );

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        'https://example.com/img1.jpg\nhttps://example.com/img2.png\n'
      );
    });

    it('should output newline-separated video URLs for single video format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: {
            videos: [
              {
                url: 'https://cdn.example.com/product.mp4',
                sourceURL: 'https://example.com/product',
                source: 'script',
              },
              {
                url: 'https://cdn.example.com/demo.mp4',
                sourceURL: 'https://example.com/product',
                source: 'html',
              },
            ],
          },
        },
        ['video']
      );

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        'https://cdn.example.com/product.mp4\nhttps://cdn.example.com/demo.mp4\n'
      );
    });

    it('should output legacy video URL for single video format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: {
            video: 'https://storage.example.com/video.mp4',
          },
        },
        ['video']
      );

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        'https://storage.example.com/video.mp4\n'
      );
    });

    it('should output summary for single summary format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: { summary: 'This is a summary of the page content.' },
        },
        ['summary']
      );

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        'This is a summary of the page content.\n'
      );
    });

    it('should output formatted screenshot info for single screenshot format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: {
            screenshot: 'https://example.com/screenshot.png',
            metadata: {
              title: 'Test Page',
              sourceURL: 'https://example.com',
              description: 'A test page',
            },
          },
        },
        ['screenshot']
      );

      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Screenshot: https://example.com/screenshot.png'
        )
      );
    });

    it('should output JSON for multiple formats', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: {
            markdown: '# Test',
            links: ['https://example.com'],
            metadata: { title: 'Test' },
          },
        },
        ['markdown', 'links']
      );

      const output = stdoutWriteSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.markdown).toBe('# Test');
      expect(parsed.links).toEqual(['https://example.com']);
    });

    it('should include videos in JSON output for multiple formats', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: {
            markdown: '# Test',
            videos: [
              {
                url: 'https://cdn.example.com/product.mp4',
                sourceURL: 'https://example.com/product',
                source: 'script',
                thumbnail: 'https://cdn.example.com/poster.jpg',
              },
            ],
            metadata: { title: 'Test' },
          },
        },
        ['markdown', 'video']
      );

      const output = stdoutWriteSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.markdown).toBe('# Test');
      expect(parsed.videos).toEqual([
        {
          url: 'https://cdn.example.com/product.mp4',
          sourceURL: 'https://example.com/product',
          source: 'script',
          thumbnail: 'https://cdn.example.com/poster.jpg',
        },
      ]);
    });

    it('should output pretty JSON when pretty flag is true', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: {
            markdown: '# Test',
            links: ['https://example.com'],
          },
        },
        ['markdown', 'links'],
        undefined,
        true
      );

      const output = stdoutWriteSpy.mock.calls[0][0];
      expect(output).toContain('\n'); // Pretty print has newlines
    });

    it('should write to file when output path is provided', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: { markdown: '# Test Content' },
        },
        ['markdown'],
        '/output/test.md'
      );

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/output/test.md',
        '# Test Content',
        'utf-8'
      );
    });

    it('should handle missing data gracefully', () => {
      handleScrapeOutput(
        {
          success: true,
          data: undefined,
        },
        ['markdown']
      );

      // Should not throw, just return early
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });

    it('should fallback to rawHtml when html requested but only rawHtml available', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: { rawHtml: '<html>Content</html>' },
        },
        ['html']
      );

      expect(stdoutWriteSpy).toHaveBeenCalledWith('<html>Content</html>\n');
    });

    it('should include metadata in JSON output when present', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: {
            markdown: '# Test',
            links: [],
            metadata: {
              title: 'Test Page',
              description: 'A test',
              sourceURL: 'https://example.com',
            },
          },
        },
        ['markdown', 'links']
      );

      const output = stdoutWriteSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.metadata).toBeDefined();
      expect(parsed.metadata.title).toBe('Test Page');
    });

    it('should output JSON when --json flag is true even for single text format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: { markdown: '# Test Content' },
        },
        ['markdown'],
        undefined,
        false,
        true // json flag
      );

      const output = stdoutWriteSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.markdown).toBe('# Test Content');
    });

    it('should output JSON when --json flag is true for screenshot format', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: {
            screenshot: 'https://example.com/screenshot.png',
            metadata: {
              title: 'Test Page',
              sourceURL: 'https://example.com',
            },
          },
        },
        ['screenshot'],
        undefined,
        false,
        true // json flag
      );

      const output = stdoutWriteSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.screenshot).toBe('https://example.com/screenshot.png');
      expect(parsed.metadata.title).toBe('Test Page');
    });

    it('should infer JSON output when output file has .json extension', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: {
            screenshot: 'https://example.com/screenshot.png',
            metadata: {
              title: 'Test Page',
            },
          },
        },
        ['screenshot'],
        '/output/result.json', // .json extension
        false,
        false // no explicit json flag
      );

      // Should write JSON to file
      expect(fs.writeFileSync).toHaveBeenCalled();
      const content = (fs.writeFileSync as any).mock.calls[0][1];
      const parsed = JSON.parse(content);
      expect(parsed.screenshot).toBe('https://example.com/screenshot.png');
    });

    it('should NOT infer JSON for non-.json extensions', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: {
            screenshot: 'https://example.com/screenshot.png',
            metadata: {
              title: 'Test Page',
              sourceURL: 'https://example.com',
            },
          },
        },
        ['screenshot'],
        '/output/result.md', // .md extension
        false,
        false // no explicit json flag
      );

      // Should write formatted text, not JSON
      expect(fs.writeFileSync).toHaveBeenCalled();
      const content = (fs.writeFileSync as any).mock.calls[0][1];
      expect(content).toContain(
        'Screenshot: https://example.com/screenshot.png'
      );
      expect(() => JSON.parse(content)).toThrow(); // Not valid JSON
    });

    it('should output pretty JSON when both json and pretty flags are true', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      handleScrapeOutput(
        {
          success: true,
          data: { markdown: '# Test' },
        },
        ['markdown'],
        undefined,
        true, // pretty flag
        true // json flag
      );

      const output = stdoutWriteSpy.mock.calls[0][0];
      expect(output).toContain('\n'); // Pretty print has newlines
      const parsed = JSON.parse(output);
      expect(parsed.markdown).toBe('# Test');
    });
  });
});
