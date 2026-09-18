import { describe, expect, it } from 'vitest';
import { resolveScrapeTarget } from '../../utils/scrape-target';

describe('scrape target routing', () => {
  it('routes shorthand and explicit tools through identical Alexandria calls', () => {
    const options = ['{"query":"test","k":4}'];
    const shorthand = resolveScrapeTarget(['firecrawl-research-index/read'], {
      options,
    });
    expect(shorthand).toEqual(
      resolveScrapeTarget([], {
        alexandria: ['firecrawl-research-index/read'],
        options,
      })
    );
    expect(shorthand).toMatchObject({
      kind: 'alexandria',
      calls: [
        {
          provider: 'firecrawl-research-index',
          capability: 'read',
          options: { query: 'test', k: 4 },
        },
      ],
    });
    expect(resolveScrapeTarget(['benzing/news/serch'], {}).kind).toBe(
      'alexandria'
    );
  });

  it.each([
    'https://example.com/a',
    'http://internal/a',
    'example.com/a',
    'example.com:8080/a?x=1',
    'localhost:3000/a',
    'localhost',
    '127.0.0.1:3000/a',
    '[::1]:3000/a',
  ])('keeps %s on URL scraping', (target) => {
    expect(resolveScrapeTarget([target], {}).kind).toBe('url');
    expect(resolveScrapeTarget([], { url: target }).kind).toBe('url');
  });

  it.each(['provider_name/search', 'provider~name/search', '_provider/search'])(
    'accepts supported address characters in %s',
    (address) => {
      expect(resolveScrapeTarget([address], {})).toEqual(
        resolveScrapeTarget([], { alexandria: [address] })
      );
    }
  );

  it.each(['amazon', 'provider/search', 'https://', ''])(
    'rejects invalid --url %s locally',
    (url) => {
      expect(() => resolveScrapeTarget([], { url })).toThrow('firecrawl list');
    }
  );

  it('preserves multiple URLs and positional output formats', () => {
    expect(
      resolveScrapeTarget(
        ['example.com/a', 'example.org', 'Markdown, links'],
        {}
      )
    ).toMatchObject({
      kind: 'url',
      urls: ['https://example.com/a', 'https://example.org'],
      positionalFormats: ['Markdown, links'],
    });
  });

  it('pairs multiple tool addresses with their options in order', () => {
    expect(
      resolveScrapeTarget(
        ['benzinga/news/search', 'firecrawl-research-index/search'],
        { options: ['{"pageSize":1}', '{"query":"attention"}'] }
      )
    ).toMatchObject({
      calls: [
        { provider: 'benzinga', options: { pageSize: 1 } },
        {
          provider: 'firecrawl-research-index',
          options: { query: 'attention' },
        },
      ],
    });
  });

  it.each([
    'amazon',
    'amazon/',
    '/news/search',
    'https://',
    'provider//search',
  ])('rejects ambiguous or malformed %s locally', (value) => {
    expect(() => resolveScrapeTarget([value], {})).toThrow('firecrawl list');
  });

  it('suggests both URL and Alexandria paths for a bare name', () => {
    expect(() => resolveScrapeTarget(['amazon'], {})).toThrow(
      'https://amazon.com (suggestion only)'
    );
    expect(() => resolveScrapeTarget(['amazon'], {})).toThrow('--alexandria');
  });

  it('refuses mixed modes and malformed options', () => {
    expect(() =>
      resolveScrapeTarget(['example.com', 'benzinga/news/search'], {})
    ).toThrow('cannot be combined');
    expect(() =>
      resolveScrapeTarget(['benzinga/news/search'], {
        alexandria: ['benzinga/news/search'],
      })
    ).toThrow('not both');
    expect(() =>
      resolveScrapeTarget(['amazon'], { alexandria: ['benzinga/news/search'] })
    ).toThrow('firecrawl list');
    expect(() =>
      resolveScrapeTarget(['benzinga/news/search'], { domainTools: true })
    ).toThrow('cannot be combined');
    expect(() =>
      resolveScrapeTarget(['benzinga/news/search'], { options: ['[]'] })
    ).toThrow('JSON object');
    expect(() =>
      resolveScrapeTarget(['example.com'], { options: ['{}'] })
    ).toThrow('require a provider/capability');
  });
});
