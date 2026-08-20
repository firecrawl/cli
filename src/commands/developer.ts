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

function fmtResult(item: DeveloperItem): string {
  // The wire carries no type field; the artifact kind is the id prefix
  // (doc:, issue:, pull_request:, readme:).
  const prefix = (item.id ?? '').split(':', 1)[0];
  const kind = ['doc', 'issue', 'pull_request', 'readme'].includes(prefix)
    ? ` (${prefix})`
    : '';
  const lines = [`## [${item.id ?? '?'}]${kind} ${item.title ?? '(untitled)'}`];
  if (item.url) lines.push(item.url);
  if (item.license) lines.push(fmtLicense(item.license));
  const body = item.passages
    .map((passage) =>
      [
        passage.text,
        passage.citation_url && `Citation: ${passage.citation_url}`,
      ]
        .filter(Boolean)
        .join('\n')
    )
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
