import { getClient, isKeylessMode, keylessGet } from '../utils/client';
import { writeOutput } from '../utils/output';
import type {
  LegalRegulatoryResult,
  LegalRegulatorySearchOptions,
  LegalRegulatorySearchResponse,
} from '../types/legal-regulatory';

const BASE = '/v2/search/legal-regulatory';

async function getLegalRegulatory<T>(
  path: string,
  options: LegalRegulatorySearchOptions
): Promise<T> {
  const url = `${path}${path.includes('?') ? '&' : '?'}integration=cli`;

  if (isKeylessMode(options.apiKey, options.apiUrl)) {
    return (await keylessGet(url)) as T;
  }

  const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
  const response = await (app as any).http.get(url);
  return (response?.data ?? {}) as T;
}

function fmtResult(item: LegalRegulatoryResult, index: number): string {
  const lines = [
    `## ${item.position ?? index + 1}. ${item.title ?? '(untitled)'}`,
    item.url,
  ];
  if (item.description) lines.push(item.description);
  return lines.join('\n');
}

function fmtLegalRegulatory(data: LegalRegulatorySearchResponse): string {
  const results = data.data?.web ?? [];
  if (results.length === 0) return '(no results)';
  return results.map(fmtResult).join('\n\n');
}

function writeLegalRegulatoryOutput(
  data: LegalRegulatorySearchResponse,
  readable: string,
  options: LegalRegulatorySearchOptions
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

export async function handleLegalRegulatorySearchCommand(
  options: LegalRegulatorySearchOptions
): Promise<void> {
  try {
    const params = new URLSearchParams();
    params.append('query', options.query);
    if (options.k != null) params.append('k', String(options.k));
    const data = await getLegalRegulatory<LegalRegulatorySearchResponse>(
      `${BASE}?${params.toString()}`,
      options
    );
    writeLegalRegulatoryOutput(data, fmtLegalRegulatory(data), options);
  } catch (error) {
    handleError(error);
  }
}
