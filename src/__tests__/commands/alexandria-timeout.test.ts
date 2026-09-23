import { afterEach, expect, it, vi } from 'vitest';
import { requestAlexandria } from '../../commands/alexandria';

const calls = [{ provider: 'example', capability: 'lookup', options: {} }];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  [undefined, 120_000, 150_000],
  [10_000, 10_000, 40_000],
  [180_000, 120_000, 150_000],
])(
  'aligns execution and transport deadlines for %s',
  async (timeout, execution, transport) => {
    const signal = new AbortController().signal;
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          scrape_id: 'scrape-test',
          data: { alexandria: [{ data: { ok: true } }], creditsCost: 1 },
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await requestAlexandria(calls, {
      apiKey: 'fc-test',
      apiUrl: 'http://localhost:3100',
      requestId: 'recover-this-request',
      timeout,
      showReceipt: false,
    });
    expect(result.success).toBe(true);
    expect(deadline).toHaveBeenCalledWith(transport);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3100/v2/scrape');
    expect(JSON.parse(options.body)).toEqual({
      alexandria: calls,
      integration: 'cli',
      timeout: execution,
    });
    expect(options.headers['x-request-id']).toBe('recover-this-request');
    expect(options.signal).toBe(signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
);

it('preserves the recovery ID without retrying a transport timeout', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new DOMException('Timed out', 'TimeoutError'))
  );
  const result = await requestAlexandria(calls, {
    apiKey: 'fc-test',
    requestId: 'recover-timeout',
    showReceipt: false,
  });
  expect(result).toMatchObject({
    success: false,
    requestId: 'recover-timeout',
    error: 'Timed out',
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
