import { buildCalls } from '../commands/alexandria';
import { normalizeUrl } from './url';
import { parseFormats } from './options';

type ScrapeTargetOptions = {
  url?: string;
  alexandria?: string[];
  options?: string[];
  requestId?: string;
  domainTools?: boolean;
  toolDetail?: 'compact' | 'summary' | 'full';
};

function isPositionalFormat(value: string): boolean {
  try {
    return parseFormats(value).length > 0;
  } catch {
    return false;
  }
}

function isScrapeUrl(value: string): boolean {
  if (/^https?:\/\//i.test(value)) {
    try {
      return Boolean(new URL(value).hostname);
    } catch {
      return false;
    }
  }
  const host = value.split(/[/?#]/, 1)[0];
  if (
    !host.includes('.') &&
    !/^localhost(?::\d+)?$/i.test(host) &&
    !host.startsWith('[')
  )
    return false;
  try {
    return Boolean(new URL(normalizeUrl(value)).hostname);
  } catch {
    return false;
  }
}

function ambiguous(value: string): never {
  const suggestion = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value)
    ? `\nIf you meant a website, try https://${value}.com (suggestion only).`
    : '\nFor a website, use an http(s) URL, for example https://example.com.';
  throw new Error(
    `${JSON.stringify(value)} needs a URL or provider/capability.${suggestion}\n` +
      'Browse Alexandria providers and tools: firecrawl list\n' +
      'Run a tool: firecrawl scrape <provider>/<capability> --options \'{"query":"..."}\'\n' +
      'You can also use --alexandria <provider>/<capability>.'
  );
}

/** Resolve intent locally; Alexandria validates provider and capability existence. */
export function resolveScrapeTarget(
  args: string[],
  options: ScrapeTargetOptions
) {
  const urls: string[] = [];
  const tools: string[] = [];
  const positionalFormats: string[] = [];
  const unknown: string[] = [];
  for (const arg of args) {
    if (isScrapeUrl(arg)) urls.push(normalizeUrl(arg));
    else if (/^[a-z0-9_~.-]+\/[a-z0-9_~.-]+(?:\/[a-z0-9_~.-]+)*$/i.test(arg))
      tools.push(arg);
    else if (isPositionalFormat(arg)) positionalFormats.push(arg);
    else unknown.push(arg);
  }
  if (options.url !== undefined) {
    if (!isScrapeUrl(options.url)) ambiguous(options.url);
    urls.push(normalizeUrl(options.url));
  }
  if (unknown.length) ambiguous(unknown[0]);
  if (tools.length && options.alexandria?.length)
    throw new Error('Use positional tool addresses or --alexandria, not both.');
  const addresses = options.alexandria ?? tools;
  if (addresses.length) {
    if (
      urls.length ||
      options.domainTools ||
      options.toolDetail !== undefined ||
      positionalFormats.length
    )
      throw new Error(
        'Provider execution cannot be combined with URL scraping or positional output formats.'
      );
    return {
      kind: 'alexandria' as const,
      calls: buildCalls(addresses, options.options),
    };
  }
  if (!urls.length) {
    if (positionalFormats.length) ambiguous(positionalFormats[0]);
    throw new Error(
      'Provide a URL or provider/capability. Browse Alexandria tools with firecrawl list.'
    );
  }
  if (options.options || options.requestId)
    throw new Error(
      '--options and --request-id require a provider/capability or --alexandria.'
    );
  return { kind: 'url' as const, urls: [...new Set(urls)], positionalFormats };
}
