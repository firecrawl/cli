import { describe, expect, it } from 'vitest';
import {
  alexandriaCharge,
  alexandriaPrice,
  MERGED_ALEXANDRIA_PRICES,
  withCatalogToolPrice,
} from '../../utils/alexandria-prices';
import {
  findToolsRetryDelayMs,
  isExecutionOnlySkill,
  listedProviderSkills,
  sharedSkillLine,
} from '../../commands/alexandria';

describe('merged Alexandria prices', () => {
  it('prices Carbon Arc, Influencers.club, and People Data Labs', () => {
    expect(alexandriaPrice('carbon-arc', 'query')?.credits).toBe(1000);
    expect(
      alexandriaPrice('influencers-club', 'creators/search')
    ).toMatchObject({ credits: 45, per: 'creator returned' });
    expect(
      alexandriaPrice('influencers-club', 'creators/search')?.note
    ).toContain('56');
    expect(
      alexandriaPrice('influencers-club', 'content/details')?.note
    ).toContain('20');
    expect(
      alexandriaPrice('influencers-club', 'dictionary/languages')
    ).toMatchObject({ credits: 0 });
    expect(alexandriaCharge('people-data-labs', 'person/enrich')).toBe(60);
    expect(alexandriaCharge('people-data-labs', 'person/identify', false)).toBe(
      0
    );
    expect(alexandriaPrice('people-data-labs', 'company/bulk')).toMatchObject({
      credits: 50,
      per: 'returned or matched record',
      misses: 'free',
    });
    expect(alexandriaCharge('people-data-labs', 'company/enrich', false)).toBe(
      0
    );
    expect(alexandriaPrice('people-data-labs', 'person/preview')?.credits).toBe(
      1
    );
    expect(alexandriaPrice('people-data-labs', 'ip/enrich')?.credits).toBe(1);
    expect(
      alexandriaPrice('people-data-labs', 'job/title/enrich')?.credits
    ).toBe(1);
    expect(alexandriaPrice('people-data-labs', 'company/clean')?.credits).toBe(
      0
    );
    expect(alexandriaPrice('people-data-labs', 'autocomplete')?.credits).toBe(
      0
    );
    expect(
      MERGED_ALEXANDRIA_PRICES.some((price) =>
        price.capability.includes('async')
      )
    ).toBe(false);
    expect(
      alexandriaCharge('influencers-club', 'creators/search', {
        returnFilterValues: true,
      })
    ).toBe(56);
    expect(
      alexandriaCharge('influencers-club', 'content/details', {
        tiktokTranscript: true,
      })
    ).toBe(20);
    expect(
      withCatalogToolPrice({ provider: 'carbon-arc', capability: 'query' })
    ).toMatchObject({ creditsCost: 1000, perRecord: false });
    expect(
      withCatalogToolPrice({
        provider: 'carbon-arc',
        capability: 'query',
        creditsCost: 2,
      })
    ).toMatchObject({ creditsCost: 2 });
  });
});

describe('find-tools embed retry', () => {
  it('caps the wait at 3 seconds', () => {
    expect(findToolsRetryDelayMs(undefined)).toBe(0);
    expect(findToolsRetryDelayMs(0)).toBe(0);
    expect(findToolsRetryDelayMs(1)).toBe(1000);
    expect(findToolsRetryDelayMs(30)).toBe(3000);
  });
});

describe('provider skills', () => {
  it('hides execution-only skills and keeps the provider id', () => {
    expect(isExecutionOnlySkill({ executionOnly: true })).toBe(true);
    expect(isExecutionOnlySkill({ kind: 'execution-only' })).toBe(true);
    expect(isExecutionOnlySkill({ visibility: 'Execution_Only' })).toBe(true);
    const page = listedProviderSkills(
      {
        skills: [
          {
            provider: 'acme',
            plugin: 'research',
            skill: 'brief',
            name: 'Brief',
            description: 'Write a brief',
          },
          {
            provider: 'acme',
            plugin: 'research',
            skill: 'run',
            execution_only: true,
            name: 'Run',
          },
          {
            provider: 'other',
            plugin: 'research',
            skill: 'brief',
            name: 'Other',
          },
          {
            provider: 'acme',
            plugin: 'research',
            skill: 'hidden',
            visibility: 'execute',
            name: 'Hidden',
          },
        ],
      },
      { provider: 'acme', query: 'brief' }
    );
    expect(page.provider).toBe('acme');
    expect(page.skills.map((skill) => skill.skill)).toEqual(['brief']);
    expect(page.total).toBe(1);
    const nested = listedProviderSkills(
      {
        providers: [
          {
            provider: 'acme',
            plugins: [
              {
                plugin: 'research',
                skills: [{ skill: 'nested', name: 'Nested brief' }],
              },
            ],
          },
        ],
      },
      { provider: 'acme', query: 'nested' }
    );
    expect(nested.provider).toBe('acme');
    expect(nested.skills).toEqual([
      {
        skill: 'nested',
        name: 'Nested brief',
        provider: 'acme',
        plugin: 'research',
      },
    ]);
  });

  it('prints a shared skill id or link from a skill write', () => {
    expect(
      sharedSkillLine({
        data: {
          alexandria: [
            {
              capability: 'update-skill',
              data: {
                publicId: 'pub_123',
                url: 'https://www.firecrawl.dev/skills/pub_123',
              },
            },
          ],
        },
      })
    ).toBe('Shared skill: https://www.firecrawl.dev/skills/pub_123 (pub_123)');
    expect(
      sharedSkillLine({
        data: {
          alexandria: [
            { capability: 'read-skill', data: { url: 'https://example.com' } },
          ],
        },
      })
    ).toBeUndefined();
  });
});
