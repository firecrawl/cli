export interface Receipt {
  creditsUsed?: number;
  separatelyBilledCredits?: number;
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
  const sqlCosts =
    operationType === 'scrape' && Array.isArray(entries)
      ? entries
          .filter(
            (entry: any) =>
              entry?.provider === 'firecrawl' &&
              entry?.capability === 'sql' &&
              !entry.error &&
              entry?.data?.kind === 'result'
          )
          .map((entry: any) => entry.data.creditsCost)
      : [];
  const validSqlCosts = sqlCosts.filter(
    (cost: unknown): cost is number =>
      typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
  );
  const separatelyBilledCredits =
    validSqlCosts.length > 0
      ? validSqlCosts.reduce((sum: number, cost: number) => sum + cost, 0)
      : undefined;
  return {
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
  if (receipt.separatelyBilledCredits !== undefined) {
    if (receipt.creditsUsed !== undefined) {
      console.error(
        `Credits: ${receipt.creditsUsed + receipt.separatelyBilledCredits} (${receipt.creditsUsed} outer request + ${receipt.separatelyBilledCredits} separately billed provider calls)`
      );
    } else {
      console.error(
        `Provider credits (billed separately): ${receipt.separatelyBilledCredits}`
      );
    }
  } else if (receipt.creditsUsed !== undefined) {
    console.error(`Credits: ${receipt.creditsUsed}`);
  }
}

export function printRetry(failure: Record<string, unknown>): void {
  if (typeof failure.retryAfterSeconds === 'number')
    console.error(`Retry after: ${failure.retryAfterSeconds}s`);
}
