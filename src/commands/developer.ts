import { getClient, isKeylessMode, keylessGet } from '../utils/client';
import { writeOutput } from '../utils/output';
import type { DeveloperItem, DeveloperSearchOptions } from '../types/developer';

// The other mount, /v2/developer/search, rejects keyless callers and may be
// withdrawn.
const BASE = '/v2/search/developer';
const LEGACY_MAX_PASSAGE_CHARS = 1200;

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

function fmtDeveloper(
  results?: DeveloperItem[],
  passageBudgetApplied?: number
): string {
  if (!results || results.length === 0) return '(no results)';

  return results
    .map((item) => {
      // The wire carries no type field; the artifact kind is the id prefix
      // (doc:, issue:, pull_request:, readme:).
      const prefix = (item.id ?? '').split(':', 1)[0];
      const kind = ['doc', 'issue', 'pull_request', 'readme'].includes(prefix)
        ? ` (${prefix})`
        : '';
      const lines = [
        `## [${item.id ?? '?'}]${kind} ${item.title ?? '(untitled)'}`,
      ];
      if (item.url) lines.push(item.url);
      const body = (item.passages ?? [])
        .map((passage) => passage.text ?? '')
        .join('\n---\n')
        .trim();
      // TODO(search#843): Remove this fallback after server passage budgeting
      // is fully enabled.
      const renderedBody =
        passageBudgetApplied == null
          ? body.slice(0, LEGACY_MAX_PASSAGE_CHARS)
          : body;
      lines.push(renderedBody || '(no content)');
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
    const data = await getDeveloper<{
      results?: DeveloperItem[];
      passage_budget_applied?: number;
    }>(`${BASE}?${params.toString()}`, options);
    writeDeveloperOutput(
      data,
      fmtDeveloper(data.results, data.passage_budget_applied),
      options
    );
  } catch (error) {
    handleError(error);
  }
}
