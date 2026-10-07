export interface Receipt {
  creditsUsed?: number;
  separatelyBilledCredits?: number;
  providerCostsComplete?: boolean;
  requestId?: string;
  operationId?: string;
  operationType?: 'scrape' | 'search';
}

export function receiptFor(
  value: any,
  operationType: 'scrape' | 'search',
  requestId?: string
): Receipt {
  const credits =
    operationType === 'search'
      ? value?.creditsUsed
      : (value?.metadata?.creditsUsed ??
        value?.creditsCost ??
        value?.data?.creditsCost);
  const operationId =
    operationType === 'search'
      ? value?.id
      : (value?.metadata?.scrapeId ?? value?.scrape_id ?? value?.scrapeId);
  const entries = value?.data?.alexandria;
  const providerResults =
    operationType === 'scrape' && Array.isArray(entries)
      ? entries.filter(
          (entry: any) => entry?.provider === 'firecrawl' && !entry.error
        )
      : [];
  const enrichmentResults = providerResults.filter(
    (entry: any) => entry.capability === 'enrich' && entry.data
  );
  const validCost = (cost: unknown): cost is number =>
    typeof cost === 'number' && Number.isFinite(cost) && cost >= 0;
  const costs = providerResults
    .flatMap((entry: any) => {
      if (entry.capability === 'sql' && entry.data?.kind === 'result')
        return [entry.data.creditsCost];
      if (entry.capability === 'enrich' && entry.data)
        return [entry.data.providerCredits];
      return [];
    })
    .filter(validCost);
  const separatelyBilledCredits =
    costs.length > 0
      ? costs.reduce((sum: number, cost: number) => sum + cost, 0)
      : undefined;
  const providerCostsComplete =
    enrichmentResults.length > 0
      ? enrichmentResults.every(
          (entry: any) =>
            entry.data.billingComplete === true &&
            validCost(entry.data.providerCredits)
        ) &&
        (separatelyBilledCredits === undefined ||
          Number.isFinite(separatelyBilledCredits))
      : undefined;
  return {
    ...(providerCostsComplete !== undefined ? { providerCostsComplete } : {}),
    ...(separatelyBilledCredits !== undefined &&
    Number.isFinite(separatelyBilledCredits)
      ? { separatelyBilledCredits }
      : {}),
    ...(typeof credits === 'number' && Number.isFinite(credits) && credits >= 0
      ? { creditsUsed: credits }
      : {}),
    ...(requestId ? { requestId } : {}),
    ...(typeof operationId === 'string' && operationId
      ? { operationId, operationType }
      : {}),
  };
}

export function printReceipt(receipt: Receipt, includeRequestId = true): void {
  if (includeRequestId && receipt.requestId)
    console.error(`Request ID: ${receipt.requestId}`);
  if (receipt.operationId)
    console.error(
      `${receipt.operationType === 'search' ? 'Search' : 'Scrape'} ID: ${receipt.operationId}`
    );
  const label =
    receipt.providerCostsComplete === false ? 'Known credits' : 'Credits';
  if (receipt.separatelyBilledCredits !== undefined) {
    if (receipt.creditsUsed !== undefined) {
      console.error(
        `${label}: ${receipt.creditsUsed + receipt.separatelyBilledCredits} (${receipt.creditsUsed} outer request + ${receipt.separatelyBilledCredits} separately billed provider calls)`
      );
    } else {
      console.error(
        `Provider credits (billed separately): ${receipt.separatelyBilledCredits}`
      );
    }
  } else if (receipt.creditsUsed !== undefined) {
    console.error(`${label}: ${receipt.creditsUsed}`);
  }
  if (receipt.providerCostsComplete === false)
    console.error(
      'Provider costs are incomplete; additional credits may have been incurred.'
    );
}

export function printRetry(failure: Record<string, unknown>): void {
  if (typeof failure.retryAfterSeconds === 'number')
    console.error(`Retry after: ${failure.retryAfterSeconds}s`);
}
