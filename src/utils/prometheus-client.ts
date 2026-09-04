/**
 * HTTP client for a Prometheus instance's /api/v1 surface.
 *
 * Prometheus runs on the caller's own Firecrawl key (BYOK): we forward it as the
 * `X-Firecrawl-Key` header and the instance uses it for that request. The base
 * URL defaults to the hosted deployment; point PROMETHEUS_API_URL (or the
 * --prometheus-url flag) elsewhere for local/self-host. PROMETHEUS_TOKEN is an
 * optional bearer, only needed if the instance sits behind a gateway.
 */
import { getApiKey } from './config';

const DEFAULT_BASE = 'https://prometheus-eta-henna.vercel.app';

/** Resolve the Prometheus base URL: flag > PROMETHEUS_API_URL > PROMETHEUS_URL > default. */
export function resolvePrometheusBase(flagUrl?: string): string {
  const base =
    flagUrl ||
    process.env.PROMETHEUS_API_URL ||
    process.env.PROMETHEUS_URL ||
    DEFAULT_BASE;
  return base.replace(/\/$/, '');
}

/**
 * Resolve the Firecrawl key (the only required credential). Throws a friendly
 * error if missing, rather than letting the request fail server-side.
 */
export function requireFirecrawlKey(providedKey?: string): string {
  const key = getApiKey(providedKey);
  if (!key) {
    throw new Error(
      'No Firecrawl API key found. Prometheus runs on your own Firecrawl key — ' +
        'run `firecrawl login`, set FIRECRAWL_API_KEY, or pass --api-key ' +
        '(get one at https://www.firecrawl.dev/app/api-keys).'
    );
  }
  return key;
}

export interface PrometheusClientOptions {
  apiKey?: string;
  prometheusUrl?: string;
}

export class PrometheusApiError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = 'PrometheusApiError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * Make a JSON request to the Prometheus API. Returns the parsed body (object or,
 * for endpoints that stream raw data, a string). Throws PrometheusApiError on a
 * non-2xx response.
 */
export async function prometheusApi<T = unknown>(
  method: string,
  path: string,
  options: PrometheusClientOptions = {},
  body?: unknown
): Promise<T> {
  const base = resolvePrometheusBase(options.prometheusUrl);
  const key = requireFirecrawlKey(options.apiKey);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-firecrawl-key': key,
  };
  const token = process.env.PROMETHEUS_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach Prometheus at ${base} — is the instance up? (${msg})`
    );
  }

  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  const data =
    ct.includes('application/json') && text ? JSON.parse(text) : text;

  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new PrometheusApiError(message, res.status, data);
  }
  return data as T;
}
