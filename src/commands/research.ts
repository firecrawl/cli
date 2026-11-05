import { getClient, isKeylessMode, keylessGet } from '../utils/client';
import { getCliOrigin } from '../utils/agent-origin';
import { writeOutput } from '../utils/output';
import type {
  InspectPaperOptions,
  PaperHit,
  ReadPaperOptions,
  RelatedPapersOptions,
  ResearchBaseOptions,
  SearchPapersOptions,
} from '../types/research';

const BASE = '/v2/search/research';
const MAX_AUTHORS = 15;
const MAX_ABSTRACT_CHARS = 600;
const MAX_AUTHORS_LINE_CHARS = 400;

function appendParam(
  params: URLSearchParams,
  key: string,
  value: string | number | boolean | string[] | undefined
): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item != null && String(item).length > 0) {
        params.append(key, String(item));
      }
    }
    return;
  }
  params.append(key, String(value));
}

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function getResearch<T>(
  path: string,
  options: ResearchBaseOptions
): Promise<T> {
  const url = `${path}${path.includes('?') ? '&' : '?'}integration=cli&origin=${encodeURIComponent(getCliOrigin())}`;

  if (isKeylessMode(options.apiKey, options.apiUrl)) {
    return (await keylessGet(url)) as T;
  }

  const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
  const response = await (app as any).http.get(url);
  return (response?.data ?? {}) as T;
}

function displayId(paper: PaperHit): string {
  return paper.primaryId ?? 'missing-primary-id';
}

function fmtAuthors(authors?: PaperHit['authors']): string | null {
  if (!authors) return null;
  const names = (typeof authors === 'string' ? authors.split(',') : authors)
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  const extra =
    names.length > MAX_AUTHORS
      ? typeof authors === 'string'
        ? `; +${names.length - MAX_AUTHORS} more`
        : '; et al.'
      : '';
  return (
    ('Authors: ' + names.slice(0, MAX_AUTHORS).join('; ')).slice(
      0,
      MAX_AUTHORS_LINE_CHARS - extra.length
    ) + extra
  );
}

function fmtDates(paper: PaperHit): string | null {
  const dates = [
    paper.createdDate ? `created ${paper.createdDate}` : '',
    paper.updateDate ? `updated ${paper.updateDate}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  return dates ? `Dates: ${dates}` : null;
}

function fmtHits(results?: PaperHit[]): string {
  if (!results || results.length === 0) return '(no results)';

  return results
    .map((paper) => {
      const lines = [`## [${displayId(paper)}] ${paper.title ?? '(untitled)'}`];
      const authors = fmtAuthors(paper.authors);
      if (authors) lines.push(authors);
      const dates = fmtDates(paper);
      if (dates) lines.push(dates);
      lines.push(
        (paper.abstract || '(no abstract)')
          .replace(/\s+/g, ' ')
          .slice(0, MAX_ABSTRACT_CHARS)
      );
      return lines.join('\n');
    })
    .join('\n\n');
}

function fmtPaperMetadata(paper?: PaperHit): string {
  if (!paper) return '(paper not found)';

  const lines = [`# ${paper.title ?? '(untitled)'}`, ''];
  lines.push(`Paper ID: ${paper.paperId ?? '?'}`);

  const ids = Object.entries(paper.ids ?? {})
    .flatMap(([namespace, values]) =>
      values.map((value) => `${namespace}:${value}`)
    )
    .join(', ');
  if (ids) lines.push(`IDs: ${ids}`);

  const authors = fmtAuthors(paper.authors);
  if (authors) lines.push(authors);

  if (paper.categories?.length) {
    lines.push(`Categories: ${paper.categories.join(', ')}`);
  }

  const dates = fmtDates(paper);
  if (dates) lines.push(dates);

  lines.push('', '## Abstract');
  lines.push((paper.abstract || '(no abstract)').replace(/\s+/g, ' '));
  return lines.join('\n');
}

function writeResearchOutput(
  data: unknown,
  readable: string,
  options: ResearchBaseOptions
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

export async function handleSearchPapersCommand(
  options: SearchPapersOptions
): Promise<void> {
  try {
    const params = new URLSearchParams();
    appendParam(params, 'query', options.query);
    appendParam(params, 'k', options.k);
    appendParam(params, 'authors', options.authors);
    appendParam(params, 'categories', options.categories);
    appendParam(params, 'from', options.from);
    appendParam(params, 'to', options.to);
    appendParam(params, 'sort', options.sort);
    const data = await getResearch<{ results?: PaperHit[] }>(
      withQuery(`${BASE}/papers`, params),
      options
    );
    writeResearchOutput(data, fmtHits(data.results), options);
  } catch (error) {
    handleError(error);
  }
}

export async function handleInspectPaperCommand(
  options: InspectPaperOptions
): Promise<void> {
  try {
    const data = await getResearch<{ paper?: PaperHit }>(
      `${BASE}/papers/${encodeURIComponent(options.paperId)}`,
      options
    );
    writeResearchOutput(data, fmtPaperMetadata(data.paper), options);
  } catch (error) {
    handleError(error);
  }
}

export async function handleRelatedPapersCommand(
  options: RelatedPapersOptions
): Promise<void> {
  try {
    const [primary, ...anchors] = options.seedIds;
    const params = new URLSearchParams();
    appendParam(params, 'intent', options.intent);
    appendParam(params, 'mode', options.mode);
    appendParam(params, 'k', options.k);
    appendParam(params, 'rerank', options.rerank);
    appendParam(params, 'anchor', anchors);
    const data = await getResearch<{
      results?: PaperHit[];
      poolSize?: number;
      note?: string | null;
    }>(
      withQuery(
        `${BASE}/papers/${encodeURIComponent(primary)}/similar`,
        params
      ),
      options
    );
    const note = data.note ? `\nnote: ${data.note}` : '';
    writeResearchOutput(
      data,
      `${fmtHits(data.results)}\n(poolSize=${data.poolSize ?? 0})${note}`,
      options
    );
  } catch (error) {
    handleError(error);
  }
}

export async function handleReadPaperCommand(
  options: ReadPaperOptions
): Promise<void> {
  try {
    const params = new URLSearchParams();
    appendParam(params, 'query', options.question);
    appendParam(params, 'k', options.k);
    const data = await getResearch<{ passages?: { text: string }[] }>(
      withQuery(
        `${BASE}/papers/${encodeURIComponent(options.paperId)}`,
        params
      ),
      options
    );
    const passages = data.passages ?? [];
    writeResearchOutput(
      data,
      passages.length
        ? passages.map((passage) => passage.text).join('\n---\n')
        : '(no full-text passages available for this paper)',
      options
    );
  } catch (error) {
    handleError(error);
  }
}
