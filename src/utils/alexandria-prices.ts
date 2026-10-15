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
