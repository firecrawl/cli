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
  for (const rawLine of (text ?? '').split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/[ \t]+$/, '');
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

type FenceContainerPart =
  | { kind: 'quote' }
  | { kind: 'indent'; column: number };

function advanceMarkdownColumn(column: number, text: string): number {
  for (const character of text) {
    column = character === '\t' ? column + (4 - (column % 4)) : column + 1;
  }
  return column;
}

function consumeIndentToColumn(
  text: string,
  column: number,
  target: number
): { rest: string; column: number } | null {
  let index = 0;
  while (column < target) {
    const character = text[index];
    if (character !== ' ' && character !== '\t') return null;
    column = advanceMarkdownColumn(column, character);
    if (column > target) return null;
    index += 1;
  }
  return column === target ? { rest: text.slice(index), column } : null;
}

interface OpenFence {
  marker: '`' | '~';
  length: number;
  container: FenceContainerPart[];
  closingPrefix: string;
}

function openingFenceCandidate(line: string): {
  run: string;
  tail: string;
  container: FenceContainerPart[];
  closingPrefix: string;
} | null {
  let rest = line;
  const container: FenceContainerPart[] = [];
  let closingPrefix = '';
  let column = 0;
  while (true) {
    const quote = rest.match(/^( {0,3}>)[ \t]?/);
    if (quote) {
      rest = rest.slice(quote[0].length);
      container.push({ kind: 'quote' });
      closingPrefix += quote[0];
      column = advanceMarkdownColumn(column, quote[0]);
      continue;
    }
    const list = rest.match(/^( {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+)/);
    if (list) {
      rest = rest.slice(list[1].length);
      const target = advanceMarkdownColumn(column, list[1]);
      container.push({ kind: 'indent', column: target });
      closingPrefix += ' '.repeat(target - column);
      column = target;
      continue;
    }
    break;
  }
  const match = rest.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
  return match
    ? {
        run: match[2],
        tail: match[3],
        container,
        closingPrefix: closingPrefix + match[1],
      }
    : null;
}

function closingFenceCandidate(
  line: string,
  container: FenceContainerPart[]
): { run: string; tail: string } | null {
  let rest = line;
  let column = 0;
  for (const part of container) {
    if (part.kind === 'quote') {
      const quote = rest.match(/^( {0,3}>)[ \t]?/);
      if (!quote) return null;
      rest = rest.slice(quote[0].length);
      column = advanceMarkdownColumn(column, quote[0]);
    } else {
      const indent = consumeIndentToColumn(rest, column, part.column);
      if (!indent) return null;
      rest = indent.rest;
      column = indent.column;
    }
  }
  const match = rest.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  return match ? { run: match[1], tail: match[2] } : null;
}

function observeFence(
  line: string,
  open: OpenFence | undefined
): OpenFence | undefined {
  if (open) {
    const candidate = closingFenceCandidate(line, open.container);
    if (!candidate) return open;
    const marker = candidate.run[0] as OpenFence['marker'];
    return marker === open.marker &&
      candidate.run.length >= open.length &&
      /^[ \t]*$/.test(candidate.tail)
      ? undefined
      : open;
  }
  const candidate = openingFenceCandidate(line);
  if (!candidate) return undefined;
  const marker = candidate.run[0] as OpenFence['marker'];
  const tail = candidate.tail.trim();
  if (marker === '`' && tail.includes('`')) return undefined;
  return {
    marker,
    length: candidate.run.length,
    container: candidate.container,
    closingPrefix: candidate.closingPrefix,
  };
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
  const citationUrl = passage.citation_url
    ?.replace(/\r\n|\r|\n/g, ' ')
    .replace(/[ \t]+$/, '');
  const citation = citationUrl ? `Citation: ${citationUrl}` : undefined;
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
    .trimEnd();
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
