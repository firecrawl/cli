/**
 * Tests for option parsing utilities
 */

import { describe, it, expect } from 'vitest';
import { parseFormats, parseScrapeOptions } from '../../utils/options';

describe('Option Parsing Utilities', () => {
  describe('parseFormats', () => {
    describe('Single format parsing', () => {
      it('should parse single markdown format', () => {
        expect(parseFormats('markdown')).toEqual(['markdown']);
      });

      it('should parse single html format', () => {
        expect(parseFormats('html')).toEqual(['html']);
      });

      it('should parse single rawHtml format', () => {
        expect(parseFormats('rawHtml')).toEqual(['rawHtml']);
      });

      it('should parse single links format', () => {
        expect(parseFormats('links')).toEqual(['links']);
      });

      it('should parse single images format', () => {
        expect(parseFormats('images')).toEqual(['images']);
      });

      it('should parse single screenshot format', () => {
        expect(parseFormats('screenshot')).toEqual(['screenshot']);
      });

      it('should parse single summary format', () => {
        expect(parseFormats('summary')).toEqual(['summary']);
      });

      it('should parse single json format', () => {
        expect(parseFormats('json')).toEqual(['json']);
      });

      it('should parse single branding format', () => {
        expect(parseFormats('branding')).toEqual(['branding']);
      });

      it('should parse single changeTracking format', () => {
        expect(parseFormats('changeTracking')).toEqual(['changeTracking']);
      });

      it('should parse single attributes format', () => {
        expect(parseFormats('attributes')).toEqual(['attributes']);
      });
    });

    describe('Multiple format parsing', () => {
      it('should parse comma-separated formats', () => {
        expect(parseFormats('markdown,links')).toEqual(['markdown', 'links']);
      });

      it('should parse multiple formats with spaces', () => {
        expect(parseFormats('markdown, links, images')).toEqual([
          'markdown',
          'links',
          'images',
        ]);
      });

      it('should handle all common formats together', () => {
        expect(parseFormats('markdown,html,links,images,screenshot')).toEqual([
          'markdown',
          'html',
          'links',
          'images',
          'screenshot',
        ]);
      });
    });

    describe('Case insensitivity', () => {
      it('should handle lowercase input', () => {
        expect(parseFormats('markdown')).toEqual(['markdown']);
      });

      it('should handle uppercase input', () => {
        expect(parseFormats('MARKDOWN')).toEqual(['markdown']);
      });

      it('should handle mixed case input', () => {
        expect(parseFormats('MarkDown')).toEqual(['markdown']);
      });

      it('should handle mixed case for camelCase formats', () => {
        expect(parseFormats('rawhtml')).toEqual(['rawHtml']);
        expect(parseFormats('RAWHTML')).toEqual(['rawHtml']);
        expect(parseFormats('RawHtml')).toEqual(['rawHtml']);
      });

      it('should handle mixed case for changeTracking', () => {
        expect(parseFormats('changetracking')).toEqual(['changeTracking']);
        expect(parseFormats('CHANGETRACKING')).toEqual(['changeTracking']);
      });
    });

    describe('Deduplication', () => {
      it('should remove duplicate formats', () => {
        expect(parseFormats('markdown,markdown,links')).toEqual([
          'markdown',
          'links',
        ]);
      });

      it('should remove duplicates with different cases', () => {
        expect(parseFormats('markdown,MARKDOWN,Markdown')).toEqual([
          'markdown',
        ]);
      });

      it('should preserve order of first occurrence', () => {
        expect(parseFormats('links,markdown,links,html')).toEqual([
          'links',
          'markdown',
          'html',
        ]);
      });
    });

    describe('Error handling', () => {
      it('should throw error for invalid format', () => {
        expect(() => parseFormats('invalid')).toThrow(
          /Invalid format\(s\): invalid/
        );
      });

      it('should throw error for multiple invalid formats', () => {
        expect(() => parseFormats('invalid1,invalid2')).toThrow(
          /Invalid format\(s\): invalid1, invalid2/
        );
      });

      it('should throw error showing valid formats', () => {
        expect(() => parseFormats('invalid')).toThrow(/Valid formats are:/);
      });

      it('should list invalid formats among valid ones', () => {
        expect(() => parseFormats('markdown,invalid,links')).toThrow(
          /Invalid format\(s\): invalid/
        );
      });
    });

    describe('Edge cases', () => {
      it('should handle empty format parts', () => {
        expect(parseFormats('markdown,,links')).toEqual(['markdown', 'links']);
      });

      it('should handle whitespace-only parts', () => {
        expect(parseFormats('markdown,   ,links')).toEqual([
          'markdown',
          'links',
        ]);
      });

      it('should handle leading/trailing whitespace', () => {
        expect(parseFormats('  markdown  ,  links  ')).toEqual([
          'markdown',
          'links',
        ]);
      });
    });
  });

  describe('parseScrapeOptions', () => {
    it('should parse basic scrape options', () => {
      const options = {
        url: 'https://example.com',
        format: 'markdown',
      };

      const result = parseScrapeOptions(options);

      expect(result.url).toBe('https://example.com');
      expect(result.formats).toEqual(['markdown']);
    });

    it('should parse multiple formats', () => {
      const options = {
        url: 'https://example.com',
        format: 'markdown,links,images',
      };

      const result = parseScrapeOptions(options);

      expect(result.formats).toEqual(['markdown', 'links', 'images']);
    });

    it('should parse onlyMainContent option', () => {
      const options = {
        url: 'https://example.com',
        onlyMainContent: true,
      };

      const result = parseScrapeOptions(options);

      expect(result.onlyMainContent).toBe(true);
    });

    it('should parse waitFor option', () => {
      const options = {
        url: 'https://example.com',
        waitFor: 3000,
      };

      const result = parseScrapeOptions(options);

      expect(result.waitFor).toBe(3000);
    });

    it('should parse screenshot option', () => {
      const options = {
        url: 'https://example.com',
        screenshot: true,
      };

      const result = parseScrapeOptions(options);

      expect(result.screenshot).toBe(true);
    });

    it('should parse includeTags from comma-separated string', () => {
      const options = {
        url: 'https://example.com',
        includeTags: 'article, main, section',
      };

      const result = parseScrapeOptions(options);

      expect(result.includeTags).toEqual(['article', 'main', 'section']);
    });

    it('should parse excludeTags from comma-separated string', () => {
      const options = {
        url: 'https://example.com',
        excludeTags: 'nav, footer, .ad',
      };

      const result = parseScrapeOptions(options);

      expect(result.excludeTags).toEqual(['nav', 'footer', '.ad']);
    });

    it('should parse apiKey option', () => {
      const options = {
        url: 'https://example.com',
        apiKey: 'fc-test-api-key',
      };

      const result = parseScrapeOptions(options);

      expect(result.apiKey).toBe('fc-test-api-key');
    });

    it('should parse apiUrl option', () => {
      const options = {
        url: 'https://example.com',
        apiUrl: 'http://localhost:3002',
      };

      const result = parseScrapeOptions(options);

      expect(result.apiUrl).toBe('http://localhost:3002');
    });

    it('should parse output option', () => {
      const options = {
        url: 'https://example.com',
        output: '.firecrawl/example.md',
      };

      const result = parseScrapeOptions(options);

      expect(result.output).toBe('.firecrawl/example.md');
    });

    it('should parse pretty option', () => {
      const options = {
        url: 'https://example.com',
        pretty: true,
      };

      const result = parseScrapeOptions(options);

      expect(result.pretty).toBe(true);
    });

    it('should parse timing option', () => {
      const options = {
        url: 'https://example.com',
        timing: true,
      };

      const result = parseScrapeOptions(options);

      expect(result.timing).toBe(true);
    });

    it('should handle undefined format', () => {
      const options = {
        url: 'https://example.com',
      };

      const result = parseScrapeOptions(options);

      expect(result.formats).toBeUndefined();
    });

    it('should handle all options together', () => {
      const options = {
        url: 'https://example.com',
        format: 'markdown,links',
        onlyMainContent: true,
        waitFor: 2000,
        screenshot: true,
        includeTags: 'article,main',
        excludeTags: 'nav,footer',
        apiKey: 'fc-test-key',
        apiUrl: 'http://localhost:3002',
        output: '.firecrawl/output.json',
        pretty: true,
        timing: true,
      };

      const result = parseScrapeOptions(options);

      expect(result).toEqual({
        url: 'https://example.com',
        formats: ['markdown', 'links'],
        onlyMainContent: true,
        waitFor: 2000,
        screenshot: true,
        includeTags: ['article', 'main'],
        excludeTags: ['nav', 'footer'],
        apiKey: 'fc-test-key',
        apiUrl: 'http://localhost:3002',
        output: '.firecrawl/output.json',
        pretty: true,
        timing: true,
      });
    });
  });
});
