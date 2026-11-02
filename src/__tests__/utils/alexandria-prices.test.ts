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
  pluginIdOf,
  providerSlugOf,
  skillAppUrl,
  skillSlugOf,
  teamSkillSlug,
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
  const carbonArcPage = {
    provider: { slug: 'carbon-arc', name: 'Carbon Arc' },
    plugins: [
      {
        id: 'carbon-arc-company-intelligence',
        displayName: 'Carbon Arc Company Intelligence',
        visibility: 'execution-only',
      },
    ],
    skills: [
      {
        id: 'provider:carbon-arc/carbon-arc-company-intelligence/ca-audience',
        name: 'ca-audience',
        description: 'Audience report',
        visibility: 'execution-only',
        provider: { slug: 'carbon-arc', name: 'Carbon Arc' },
        plugin: {
          id: 'carbon-arc-company-intelligence',
          displayName: 'Carbon Arc Company Intelligence',
        },
      },
      {
        id: 'provider:other/research/brief',
        name: 'brief',
        description: 'Audience report from someone else',
        provider: { slug: 'other', name: 'Other' },
        plugin: { id: 'research', displayName: 'Research' },
      },
    ],
    page: 1,
    limit: 20,
    total: 2,
  };

  it('reads the live provider-skills shape, including execution-only skills', () => {
    expect(isExecutionOnlySkill({ visibility: 'Execution_Only' })).toBe(true);
    expect(isExecutionOnlySkill(carbonArcPage.skills[0])).toBe(true);
    expect(providerSlugOf(carbonArcPage.skills[0].provider)).toBe('carbon-arc');
    expect(pluginIdOf(carbonArcPage.skills[0].plugin)).toBe(
      'carbon-arc-company-intelligence'
    );
    expect(skillSlugOf(carbonArcPage.skills[0])).toBe('ca-audience');
    const page = listedProviderSkills(carbonArcPage, {
      provider: 'carbon-arc',
      query: 'audience',
    });
    expect(page.skills.map(skillSlugOf)).toEqual(['ca-audience']);
    const duplicated = listedProviderSkills(
      {
        skills: [
          {
            id: 'provider:acme/research/brief',
            name: 'brief',
            description: 'plain',
            provider: { slug: 'acme' },
            plugin: { id: 'research' },
          },
        ],
        plugins: [
          {
            id: 'research',
            skills: [
              {
                id: 'provider:acme/research/brief',
                name: 'brief',
                description: 'audience brief',
                provider: { slug: 'acme' },
                plugin: { id: 'research' },
              },
            ],
          },
        ],
      },
      { provider: 'acme', query: 'audience' }
    );
    expect(duplicated.skills.map((skill) => skill.description)).toEqual([
      'audience brief',
    ]);
    const nested = listedProviderSkills(
      {
        providers: [
          {
            provider: { slug: 'acme', name: 'Acme' },
            plugins: [
              {
                id: 'research',
                displayName: 'Research',
                skills: [{ name: 'Nested brief', description: 'nested note' }],
              },
            ],
          },
        ],
      },
      { provider: 'acme', query: 'nested' }
    );
    expect(nested.skills).toEqual([
      {
        name: 'Nested brief',
        description: 'nested note',
        provider: { slug: 'acme' },
        plugin: { id: 'research' },
      },
    ]);
  });

  it('builds the app skill page from the slug and ignores sharePath', () => {
    expect(teamSkillSlug('team:weekly-digest')).toBe('weekly-digest');
    expect(teamSkillSlug('weekly-digest')).toBe('weekly-digest');
    expect(teamSkillSlug('team:')).toBeUndefined();
    expect(teamSkillSlug('team:a/b')).toBeUndefined();
    const saved = {
      success: true,
      data: {
        alexandria: [
          {
            capability: 'create-skill',
            data: {
              id: 'team:weekly-digest',
              skill: {
                slug: 'weekly-digest',
                skillId: 'team:weekly-digest',
                publicId: '55a529aa8f8e4659ab2cdc80808e0ab2',
                sharePath: '/skills/s/55a529aa8f8e4659ab2cdc80808e0ab2',
              },
            },
          },
        ],
      },
    };
    expect(skillAppUrl(saved)).toBe(
      'https://www.firecrawl.dev/app/alexandria/skills/weekly-digest'
    );
    expect(
      skillAppUrl({
        success: true,
        data: {
          alexandria: [
            {
              capability: 'update-skill',
              data: { id: 'team:weekly-digest' },
            },
          ],
        },
      })
    ).toBe('https://www.firecrawl.dev/app/alexandria/skills/weekly-digest');
    expect(
      skillAppUrl({
        success: true,
        data: {
          alexandria: [
            {
              capability: 'create-skill',
              error: { code: 'invalid_option' },
              data: {
                skill: {
                  publicId: '55a529aa8f8e4659ab2cdc80808e0ab2',
                  sharePath: '/skills/s/55a529aa8f8e4659ab2cdc80808e0ab2',
                },
              },
            },
          ],
        },
      })
    ).toBeUndefined();
  });
});
