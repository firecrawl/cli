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

const enrichmentResponse = (
  cost: unknown,
  complete: unknown = true,
  overrides = {}
) => ({
  data: {
    creditsCost: 0,
    alexandria: [
      {
        provider: 'firecrawl',
        capability: 'enrich',
        data: {
          status: 'matched',
          providerCredits: cost,
          billingComplete: complete,
          steps: [{ creditsCost: cost }],
        },
        ...overrides,
      },
    ],
  },
});
it('shows enrichment provider costs once while retaining the zero outer charge', () => {
  const receipt = receiptFor(enrichmentResponse(30), 'scrape');
  expect(receipt).toEqual({
    creditsUsed: 0,
    separatelyBilledCredits: 30,
    providerCostsComplete: true,
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    printReceipt(receipt);
    expect(log).toHaveBeenCalledWith(
      'Credits: 30 (0 outer request + 30 separately billed provider calls)'
    );
    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});
it('labels partial enrichment costs without claiming they are the final total', () => {
  const receipt = receiptFor(enrichmentResponse(5, false), 'scrape');
  expect(receipt).toMatchObject({
    separatelyBilledCredits: 5,
    providerCostsComplete: false,
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    printReceipt(receipt);
    expect(log).toHaveBeenCalledWith(
      'Known credits: 5 (0 outer request + 5 separately billed provider calls)'
    );
    expect(log).toHaveBeenCalledWith(
      'Provider costs are incomplete; additional credits may have been incurred.'
    );
  } finally {
    log.mockRestore();
  }
});
it('preserves confirmed zero-cost enrichment', () => {
  expect(receiptFor(enrichmentResponse(0), 'scrape')).toEqual({
    creditsUsed: 0,
    separatelyBilledCredits: 0,
    providerCostsComplete: true,
  });
});
it.each([undefined, -1, NaN, Infinity, '30'])(
  'does not present malformed enrichment costs as complete: %s',
  (cost) => {
    expect(receiptFor(enrichmentResponse(cost), 'scrape')).toEqual({
      creditsUsed: 0,
      providerCostsComplete: false,
    });
  }
);
it.each([
  { provider: 'other' },
  { capability: 'bash' },
  { error: { code: 'unauthorized' } },
])('ignores unrelated or rejected enrichment-like data: %j', (overrides) => {
  expect(receiptFor(enrichmentResponse(30, true, overrides), 'scrape')).toEqual(
    { creditsUsed: 0 }
  );
});
it('preserves separate SQL and enrichment costs without changing search receipts', () => {
  const value = {
    data: {
      creditsCost: 0,
      alexandria: [
        ...sqlResponse(10).data.alexandria,
        ...enrichmentResponse(30).data.alexandria,
      ],
    },
  };
  expect(receiptFor(value, 'scrape')).toEqual({
    creditsUsed: 0,
    separatelyBilledCredits: 40,
    providerCostsComplete: true,
  });
  expect(receiptFor({ ...value, creditsUsed: 2 }, 'search')).toEqual({
    creditsUsed: 2,
  });
});
