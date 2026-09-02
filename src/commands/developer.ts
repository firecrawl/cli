import { getClient, isKeylessMode, keylessGet } from '../utils/client';
import { writeOutput } from '../utils/output';
import type {
  DeveloperItem,
  DeveloperLicense,
  DeveloperRepoStatus,
  DeveloperSearchOptions,
  DeveloperSearchResponse,
  DeveloperSourceStatus,
} from '../types/developer';

// The other mount, /v2/developer/search, rejects keyless callers and may be
// withdrawn.
const BASE = '/v2/search/developer';

async function getDeveloper<T>(
  path: string,
  options: DeveloperSearchOptions
): Promise<T> {
  const url = `${path}${path.includes('?') ? '&' : '?'}integration=cli`;

  if (isKeylessMode(options.apiKey, options.apiUrl)) {
    return (await keylessGet(url)) as T;
  }

  const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
  const response = await (app as any).http.get(url);
  return (response?.data ?? {}) as T;
}

function fmtLicense(license: DeveloperLicense | string): string {
  // During the API migration, license may be either the disclosure object or
  // its flattened SPDX string. Render both without assuming rollout order.
  if (typeof license === 'string') return `License: ${license}`;
  if (license.state === 'licensed' && license.spdx_id) {
    return `License: ${license.spdx_id}`;
  }
  return `License: ${license.state.replace('_', ' ')}`;
}

function idEncodesUrl(id: string | undefined, url: string): boolean {
  return id === url || id?.endsWith(`:${url}`) === true;
}

const MAX_RENDERED_PASSAGE_LINES = 40;

function normalizedPassageLines(text: string | undefined): string[] {
  const lines: string[] = [];
  let blank = false;
  for (const rawLine of (text ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      if (lines.length > 0 && !blank) lines.push('');
      blank = true;
    } else {
      lines.push(line);
      blank = false;
    }
  }
  while (lines.at(-1) === '') lines.pop();
  return lines;
}

interface OpenFence {
  marker: '`' | '~';
  length: number;
  closingPrefix: string;
}

function fenceCandidate(line: string): {
  run: string;
  tail: string;
  closingPrefix: string;
} | null {
  let rest = line;
  let closingPrefix = '';
  while (true) {
    const quote = rest.match(/^( {0,3}>[ \t]?)/);
    if (quote) {
      rest = rest.slice(quote[1].length);
      closingPrefix += quote[1];
      continue;
    }
    const list = rest.match(/^( {0,3}(?:[-+*]|\d+[.)])[ \t]+)/);
    if (list) {
      rest = rest.slice(list[1].length);
      closingPrefix += ' '.repeat(list[1].length);
      continue;
    }
    break;
  }
  const match = rest.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
  return match
    ? {
        run: match[2],
        tail: match[3],
        closingPrefix: closingPrefix + match[1],
      }
    : null;
}

function observeFence(
  line: string,
  open: OpenFence | undefined
): OpenFence | undefined {
  const candidate = fenceCandidate(line);
  if (!candidate) return open;
  const { run, tail: rawTail, closingPrefix } = candidate;
  const marker = run[0] as OpenFence['marker'];
  const tail = rawTail.trim();
  if (open) {
    return marker === open.marker && run.length >= open.length && tail === ''
      ? undefined
      : open;
  }
  if (marker === '`' && tail.includes('`')) return undefined;
  return { marker, length: run.length, closingPrefix };
}

function cappedPassageLines(lines: string[], capacity: number): string[] {
  if (lines.length <= capacity) return lines;

  // Reserve one line for the truncation notice. Prefer the last boundary that
  // is outside a fenced block, so a terminal cap does not recreate the old
  // character-slice bug that left Markdown fences open.
  const contentCapacity = capacity - 1;
  let open: OpenFence | undefined;
  let lastSafe = 0;
  for (let index = 0; index < contentCapacity; index += 1) {
    open = observeFence(lines[index], open);
    if (!open) lastSafe = index + 1;
  }

  let kept: string[];
  let sourceLines: number;
  if (lastSafe > 0) {
    kept = lines.slice(0, lastSafe);
    sourceLines = lastSafe;
  } else if (open && contentCapacity >= 2) {
    // A passage can itself begin with a long fence. Keep a bounded preview and
    // render its closing marker before the notice.
    sourceLines = contentCapacity - 1;
    kept = [
      ...lines.slice(0, sourceLines),
      `${open.closingPrefix}${open.marker.repeat(open.length)}`,
    ];
  } else {
    sourceLines = contentCapacity;
    kept = lines.slice(0, sourceLines);
  }
  kept.push(
    `… (${lines.length - sourceLines} more lines; use --json for the full passage)`
  );
  return kept;
}

function fmtPassage(
  passage: Partial<DeveloperItem['passages'][number]>
): string {
  const citation = passage.citation_url
    ? `Citation: ${passage.citation_url}`
    : undefined;
  const metadataLines = citation ? 1 : 0;
  const lines = cappedPassageLines(
    normalizedPassageLines(passage.text),
    MAX_RENDERED_PASSAGE_LINES - metadataLines
  );
  if (citation) lines.push(citation);
  return lines.join('\n');
}

function fmtResult(item: DeveloperItem): string {
  // The wire carries no type field; the artifact kind is the id prefix
  // (doc:, issue:, pull_request:, readme:).
  const prefix = (item.id ?? '').split(':', 1)[0];
  const kind = ['doc', 'issue', 'pull_request', 'readme'].includes(prefix)
    ? ` (${prefix})`
    : '';
  const lines = [`## [${item.id ?? '?'}]${kind} ${item.title ?? '(untitled)'}`];
  if (item.url && !idEncodesUrl(item.id, item.url)) lines.push(item.url);
  if (item.license) lines.push(fmtLicense(item.license));
  const body = (item.passages ?? [])
    .map(fmtPassage)
    .filter((passage) => passage.length > 0)
    .join('\n---\n')
    .trim();
  lines.push(body || '(no content)');
  return lines.join('\n');
}

function fmtRepoStatuses(repos: DeveloperRepoStatus[]): string {
  const lines = ['## Repository indexing'];
  for (const status of repos) {
    const indexedTypes = Object.entries(status.types)
      .filter(([, indexed]) => indexed)
      .map(([type]) => type)
      .join(', ');
    lines.push(
      `- ${status.repo}: ${status.indexed ? `indexed (${indexedTypes || 'no requested types'})` : 'not indexed'}`
    );
  }
  return lines.join('\n');
}

function fmtSourceStatuses(sources: DeveloperSourceStatus[]): string {
  return [
    '## Documentation source indexing',
    ...sources.map(
      (status) =>
        `- ${status.source}: ${status.indexed ? 'indexed' : 'not indexed'}`
    ),
  ].join('\n');
}

function fmtDeveloper(data: DeveloperSearchResponse): string {
  const sections: string[] = [];
  const results = data.results ?? [];
  if (results.length > 0) {
    sections.push(results.map(fmtResult).join('\n\n'));
  } else {
    sections.push('(no results)');
  }
  if (data.repos?.length) sections.push(fmtRepoStatuses(data.repos));
  if (data.sources?.length) sections.push(fmtSourceStatuses(data.sources));
  return sections.join('\n\n');
}

function writeDeveloperOutput(
  data: DeveloperSearchResponse,
  readable: string,
  options: DeveloperSearchOptions
): void {
  const content =
    options.json || options.pretty
      ? options.pretty
        ? JSON.stringify(data, null, 2)
        : JSON.stringify(data)
      : readable;
  writeOutput(content, options.output, !!options.output);
}

function handleError(error: unknown): never {
  console.error(
    'Error:',
    error instanceof Error ? error.message : 'Unknown error occurred'
  );
  process.exit(1);
}

export async function handleDeveloperSearchCommand(
  options: DeveloperSearchOptions
): Promise<void> {
  try {
    const params = new URLSearchParams();
    params.append('query', options.query);
    if (options.k != null) params.append('k', String(options.k));
    const data = await getDeveloper<DeveloperSearchResponse>(
      `${BASE}?${params.toString()}`,
      options
    );
    writeDeveloperOutput(data, fmtDeveloper(data), options);
  } catch (error) {
    handleError(error);
  }
}
