export interface Receipt {
  creditsUsed?: number;
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
  return {
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
  if (receipt.creditsUsed !== undefined)
    console.error(`Credits: ${receipt.creditsUsed}`);
}

export function printRetry(failure: Record<string, unknown>): void {
  if (typeof failure.retryAfterSeconds === 'number')
    console.error(`Retry after: ${failure.retryAfterSeconds}s`);
}
