import { getClient, isKeylessMode, keylessGet } from '../utils/client';
import { writeOutput } from '../utils/output';
import type {
  GovResult,
  GovSearchOptions,
  GovSearchResponse,
} from '../types/gov';

const BASE = '/v2/search/gov';

async function getGov<T>(path: string, options: GovSearchOptions): Promise<T> {
  const url = `${path}${path.includes('?') ? '&' : '?'}integration=cli`;

  if (isKeylessMode(options.apiKey, options.apiUrl)) {
    return (await keylessGet(url)) as T;
  }

  const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
  const response = await (app as any).http.get(url);
  return (response?.data ?? {}) as T;
}

function fmtResult(item: GovResult, index: number): string {
  const lines = [
    `## ${item.position ?? index + 1}. ${item.title ?? '(untitled)'}`,
    item.url,
  ];
  if (item.description) lines.push(item.description);
  return lines.join('\n');
}

function fmtGov(data: GovSearchResponse): string {
  const results = data.data?.web ?? [];
  if (results.length === 0) return '(no results)';
  return results.map(fmtResult).join('\n\n');
}

function writeGovOutput(
  data: GovSearchResponse,
  readable: string,
  options: GovSearchOptions
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

export async function handleGovSearchCommand(
  options: GovSearchOptions
): Promise<void> {
  try {
    const params = new URLSearchParams();
    params.append('query', options.query);
    if (options.k != null) params.append('k', String(options.k));
    const data = await getGov<GovSearchResponse>(
      `${BASE}?${params.toString()}`,
      options
    );
    if (data.success === false) {
      throw new Error(data.error ?? 'Government search failed');
    }
    writeGovOutput(data, fmtGov(data), options);
  } catch (error) {
    handleError(error);
  }
}
