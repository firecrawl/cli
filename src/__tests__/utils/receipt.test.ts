import { afterEach, expect, it, vi } from 'vitest';
import { apiFailure } from '../../commands/alexandria';
import { receiptFor, printReceipt } from '../../utils/receipt';

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

const sqlResponse = (cost: unknown, overrides = {}) => ({
  data: {
    creditsCost: 0,
    alexandria: [
      {
        provider: 'firecrawl',
        capability: 'sql',
        data: { kind: 'result', creditsCost: cost },
        ...overrides,
      },
    ],
  },
});
it('shows separately billed SQL costs without changing the outer receipt charge', () => {
  const receipt = receiptFor(sqlResponse(110), 'scrape');
  expect(receipt).toEqual({ creditsUsed: 0, separatelyBilledCredits: 110 });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    printReceipt(receipt);
    expect(log).toHaveBeenCalledWith(
      'Credits: 110 (0 outer request + 110 separately billed provider calls)'
    );
  } finally {
    log.mockRestore();
  }
});
it('preserves zero-cost nested execution', () => {
  expect(receiptFor(sqlResponse(0), 'scrape')).toEqual({
    creditsUsed: 0,
    separatelyBilledCredits: 0,
  });
});
it.each([undefined, -1, NaN, Infinity, '110'])(
  'ignores invalid nested costs: %s',
  (cost) => {
    expect(receiptFor(sqlResponse(cost), 'scrape')).toEqual({ creditsUsed: 0 });
  }
);
it.each([
  { provider: 'other' },
  { capability: 'bash' },
  { error: { code: 'provider_error' } },
  { data: { kind: 'plan', creditsCost: 110 } },
])(
  'does not treat other payloads as separately billed SQL: %j',
  (overrides) => {
    expect(receiptFor(sqlResponse(110, overrides), 'scrape')).toEqual({
      creditsUsed: 0,
    });
  }
);

it('retains all valid charges when other SQL costs are invalid', () => {
  const response = {
    data: {
      creditsCost: 0,
      alexandria: [5, undefined, 110, -1, NaN, Infinity, '15', 0, 15].flatMap(
        (cost) => sqlResponse(cost).data.alexandria
      ),
    },
  };
  expect(receiptFor(response, 'scrape')).toEqual({
    creditsUsed: 0,
    separatelyBilledCredits: 130,
  });
});
it('retains a valid zero alongside invalid costs', () => {
  const response = {
    data: {
      creditsCost: 0,
      alexandria: [undefined, 0, -1].flatMap(
        (cost) => sqlResponse(cost).data.alexandria
      ),
    },
  };
  expect(receiptFor(response, 'scrape')).toEqual({
    creditsUsed: 0,
    separatelyBilledCredits: 0,
  });
});
