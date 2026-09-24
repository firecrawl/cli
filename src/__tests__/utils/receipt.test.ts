import { afterEach, expect, it, vi } from 'vitest';
import { apiFailure } from '../../commands/alexandria';
import { receiptFor } from '../../utils/receipt';

afterEach(() => vi.useRealTimers());

it('keeps actual zero charges and separates client identity from the server operation', () => {
  expect(
    receiptFor(
      { scrape_id: 'server-1', data: { creditsCost: 0 } },
      'scrape',
      'client-1'
    )
  ).toEqual({
    creditsUsed: 0,
    requestId: 'client-1',
    operationId: 'server-1',
    operationType: 'scrape',
  });
  expect(receiptFor({}, 'scrape')).toEqual({});
  expect(
    receiptFor({ metadata: { creditsUsed: -1 } }, 'scrape')
  ).not.toHaveProperty('creditsUsed');
});

it('preserves actionable errors without serializing transport credentials', () => {
  const failure = apiFailure({
    response: {
      status: 429,
      data: {
        error: 'Limited',
        code: 'RATE_LIMITED',
        requestId: 'request-1',
        retry_after_seconds: 1.5,
      },
      config: { headers: { authorization: 'secret' } },
    },
  });
  expect(failure).toEqual({
    success: false,
    error: 'Limited',
    code: 'RATE_LIMITED',
    requestId: 'request-1',
    status: 429,
    retryAfterSeconds: 2,
  });
  expect(JSON.stringify(failure)).not.toContain('secret');
});

it('handles HTTP-date retry delays without treating invalid numeric delays as dates', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-17T00:00:00Z'));
  const failure = (retry: string) =>
    apiFailure({
      response: { status: 429, headers: { 'retry-after': retry } },
    });
  expect(failure('Thu, 17 Sep 2026 00:00:03 GMT').retryAfterSeconds).toBe(3);
  for (const value of ['-5', 'nonsense', ''])
    expect(failure(value)).not.toHaveProperty('retryAfterSeconds');
});
