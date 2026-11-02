const TOOL_PRICE_KEYS = [
  'creditsCost',
  'perRecord',
  'billing',
  'recordsPerUnit',
  'zeroDataRetentionCreditsCost',
];

/** Drops per-capability price metadata from a discovered tool or an Alexandria result entry. */
export function withoutToolPrice<T>(tool: T): T {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
  const copy = { ...(tool as Record<string, unknown>) };
  for (const key of TOOL_PRICE_KEYS) delete copy[key];
  return copy as T;
}

function withoutPagePrices(page: any): any {
  if (!page || typeof page !== 'object') return page;
  return {
    ...page,
    ...(Array.isArray(page.items)
      ? { items: page.items.map(withoutToolPrice) }
      : {}),
    ...(Array.isArray(page.relatedTools)
      ? {
          relatedTools: page.relatedTools.map((group: any) =>
            Array.isArray(group?.tools)
              ? {
                  ...group,
                  tools: group.tools.map((entry: any) =>
                    entry?.tool
                      ? { ...entry, tool: withoutToolPrice(entry.tool) }
                      : withoutToolPrice(entry)
                  ),
                }
              : group
          ),
        }
      : {}),
  };
}

/**
 * Strips the per-capability cost from each Alexandria result entry and tool
 * prices from Find Tools pages. A batch of only Find Tools calls (always free)
 * also drops its zero total; other totals stay as the request's receipt.
 */
export function withoutResultPrices(
  envelope: Record<string, any>
): Record<string, any> {
  const results = envelope?.data?.alexandria;
  if (!Array.isArray(results)) return envelope;
  const isFindTools = (entry: any) =>
    entry?.provider === 'firecrawl' && entry?.capability === 'find-tools';
  const data: Record<string, any> = {
    ...envelope.data,
    alexandria: results.map((entry: any) =>
      isFindTools(entry)
        ? { ...withoutToolPrice(entry), data: withoutPagePrices(entry.data) }
        : withoutToolPrice(entry)
    ),
  };
  if (results.length && results.every(isFindTools)) delete data.creditsCost;
  return { ...envelope, data };
}

export type AlexandriaPriceUnit =
  | 'call'
  | 'successful call'
  | 'returned or matched record'
  | 'creator returned';

export type AlexandriaPrice = {
  provider: string;
  capability: string;
  credits: number;
  per: AlexandriaPriceUnit;
  /** When set, a miss or empty record is not charged. */
  misses?: 'free';
  note?: string;
};

/**
 * Merged execution prices. Discovery stays free.
 * People Data Labs async enrichment is execution-only; this CLI has no --async flag.
 */
export const MERGED_ALEXANDRIA_PRICES: readonly AlexandriaPrice[] = [
  {
    provider: 'carbon-arc',
    capability: '*',
    credits: 1000,
    per: 'call',
  },
  {
    provider: 'influencers-club',
    capability: 'creators/connected-socials',
    credits: 165,
    per: 'call',
  },
  {
    provider: 'influencers-club',
    capability: 'creators/search',
    credits: 45,
    per: 'creator returned',
    note: 'return_filter_values=true is 56 credits per creator returned.',
  },
  {
    provider: 'influencers-club',
    capability: 'creators/similar',
    credits: 50,
    per: 'creator returned',
  },
  {
    provider: 'influencers-club',
    capability: 'creators/audience-overlap',
    credits: 330,
    per: 'call',
  },
  {
    provider: 'influencers-club',
    capability: 'creators/enrich-full',
    credits: 330,
    per: 'call',
  },
  {
    provider: 'influencers-club',
    capability: 'creators/enrich-profile',
    credits: 150,
    per: 'call',
  },
  {
    provider: 'influencers-club',
    capability: 'creators/enrich-analytics',
    credits: 264,
    per: 'call',
  },
  {
    provider: 'influencers-club',
    capability: 'creators/enrich-raw',
    credits: 10,
    per: 'call',
  },
  {
    provider: 'influencers-club',
    capability: 'creators/enrich-email',
    credits: 17,
    per: 'call',
  },
  {
    provider: 'influencers-club',
    capability: 'content/posts',
    credits: 10,
    per: 'call',
  },
  {
    provider: 'influencers-club',
    capability: 'content/details',
    credits: 10,
    per: 'call',
    note: 'A TikTok transcript costs 20 credits.',
  },
  {
    provider: 'influencers-club',
    capability: 'dictionary/*',
    credits: 0,
    per: 'call',
  },
  {
    provider: 'people-data-labs',
    capability: 'person/enrich',
    credits: 60,
    per: 'successful call',
    misses: 'free',
  },
  {
    provider: 'people-data-labs',
    capability: 'person/identify',
    credits: 60,
    per: 'successful call',
    misses: 'free',
  },
  {
    provider: 'people-data-labs',
    capability: 'person/search',
    credits: 50,
    per: 'returned or matched record',
    misses: 'free',
  },
  {
    provider: 'people-data-labs',
    capability: 'person/bulk',
    credits: 50,
    per: 'returned or matched record',
    misses: 'free',
  },
  {
    provider: 'people-data-labs',
    capability: 'company/search',
    credits: 50,
    per: 'returned or matched record',
    misses: 'free',
  },
  {
    provider: 'people-data-labs',
    capability: 'company/bulk',
    credits: 50,
    per: 'returned or matched record',
    misses: 'free',
  },
  {
    provider: 'people-data-labs',
    capability: 'company/enrich',
    credits: 50,
    per: 'successful call',
    misses: 'free',
  },
  {
    provider: 'people-data-labs',
    capability: 'preview',
    credits: 1,
    per: 'call',
    misses: 'free',
  },
  {
    provider: 'people-data-labs',
    capability: 'ip/enrich',
    credits: 1,
    per: 'call',
    misses: 'free',
  },
  {
    provider: 'people-data-labs',
    capability: 'jobs',
    credits: 1,
    per: 'call',
    misses: 'free',
    note: 'Every jobs endpoint.',
  },
  {
    provider: 'people-data-labs',
    capability: 'cleaners',
    credits: 0,
    per: 'call',
    misses: 'free',
  },
  {
    provider: 'people-data-labs',
    capability: 'autocomplete',
    credits: 0,
    per: 'call',
    misses: 'free',
  },
];

function peopleDataLabsClass(capability: string): string | undefined {
  const id = capability.trim().toLowerCase();
  if (!id) return undefined;
  if (id === 'preview' || id.endsWith('/preview')) return 'preview';
  if (id === 'ip/enrich' || id.endsWith('/ip/enrich')) return 'ip/enrich';
  if (
    id === 'jobs' ||
    id.startsWith('job/') ||
    id.startsWith('jobs/') ||
    id.includes('/job/') ||
    id.includes('/jobs/')
  )
    return 'jobs';
  if (
    id === 'cleaners' ||
    id.endsWith('/clean') ||
    id.endsWith('/cleaner') ||
    id.includes('/clean/') ||
    id.includes('cleaner')
  )
    return 'cleaners';
  if (id === 'autocomplete' || id.endsWith('/autocomplete'))
    return 'autocomplete';
  return undefined;
}

/** The merged price for one provider capability, if this CLI knows it. */
export function alexandriaPrice(
  provider: string,
  capability: string
): AlexandriaPrice | undefined {
  const rows = MERGED_ALEXANDRIA_PRICES.filter(
    (row) => row.provider === provider
  );
  const exact = rows.find((row) => row.capability === capability);
  if (exact) return exact;
  if (provider === 'carbon-arc')
    return rows.find((row) => row.capability === '*');
  if (provider === 'influencers-club' && capability.startsWith('dictionary/'))
    return rows.find((row) => row.capability === 'dictionary/*');
  if (provider === 'people-data-labs') {
    const group = peopleDataLabsClass(capability);
    if (group) return rows.find((row) => row.capability === group);
  }
  return undefined;
}

/**
 * Credits for one outcome. People Data Labs misses are free.
 * A per-record price is the price of one returned or matched record.
 */
export function alexandriaCharge(
  provider: string,
  capability: string,
  matched = true
): number | undefined {
  const price = alexandriaPrice(provider, capability);
  if (!price) return undefined;
  if (!matched && price.misses === 'free') return 0;
  return price.credits;
}
