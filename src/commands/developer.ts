import { getClient, isKeylessMode, keylessGet } from '../utils/client';
import { writeOutput } from '../utils/output';
import type { DeveloperItem, DeveloperSearchOptions } from '../types/developer';

// The other mount, /v2/developer/search, rejects keyless callers and may be
// withdrawn.
const BASE = '/v2/search/developer';
const MAX_PASSAGE_CHARS = 1200;

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

function fmtDeveloper(results?: DeveloperItem[]): string {
  if (!results || results.length === 0) return '(no results)';

  return results
    .map((item) => {
      const kind = item.type ? ` (${item.type})` : '';
      const lines = [
        `## [${item.id ?? '?'}]${kind} ${item.title ?? '(untitled)'}`,
      ];
      if (item.url) lines.push(item.url);
      const body = (item.passages ?? [])
        .map((passage) => passage.text ?? '')
        .join('\n---\n')
        .trim();
      lines.push(body ? body.slice(0, MAX_PASSAGE_CHARS) : '(no content)');
      return lines.join('\n');
    })
    .join('\n\n');
}

function writeDeveloperOutput(
  data: unknown,
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
    if (options.skillsOnly) params.append('skills', 'only');
    const data = await getDeveloper<{ results?: DeveloperItem[] }>(
      `${BASE}?${params.toString()}`,
      options
    );
    writeDeveloperOutput(data, fmtDeveloper(data.results), options);
  } catch (error) {
    handleError(error);
  }
}
