import {
  getClient,
  isKeylessMode,
  keyedGet,
  keylessGet,
} from '../utils/client';
import { getCliOrigin } from '../utils/agent-origin';
import { writeOutput } from '../utils/output';
import type {
  EvidenceKind,
  InspectPaperOptions,
  LookupProteinOptions,
  PaperHit,
  ProteinEntry,
  ProteinEvidence,
  ProteinLookup,
  ProteinMatchedBy,
  ProteinStatement,
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
  return (await keyedGet(app, url)) as T;
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

const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  experimental: 'Experimental',
  large_scale_experimental: 'Experimental, large-scale',
  author_statement: 'Author statement',
  curator_inference: 'Curator inference',
  by_similarity: 'Inferred from a related protein',
  sequence_analysis: 'Predicted from sequence',
  imported: 'Imported from another database',
  untagged: 'No evidence tag',
};

const MATCHED_BY_LABELS: Record<ProteinMatchedBy, string> = {
  accession: 'accession',
  secondary_accession: 'secondary accession',
  entry_name: 'entry name',
  gene: 'gene symbol',
  synonym: 'gene synonym',
  name: 'protein name',
};

const isMeasured = (kind: EvidenceKind) =>
  kind === 'experimental' || kind === 'large_scale_experimental';

function measuredFirst<T>(items: T[], measured: (item: T) => boolean): T[] {
  return [
    ...items.filter(measured),
    ...items.filter((item) => !measured(item)),
  ];
}

const fmtIds = (ids: string[]) => (ids.length ? ` [${ids.join(', ')}]` : '');

function fmtEvidence(evidence: ProteinEvidence[]): string {
  const idsByKind = new Map<EvidenceKind, string[]>();
  for (const { kind, paperId, fromProtein } of evidence) {
    const ids = idsByKind.get(kind) ?? [];
    const id = paperId ?? fromProtein;
    if (id && !ids.includes(id)) ids.push(id);
    idsByKind.set(kind, ids);
  }
  return measuredFirst([...idsByKind], ([kind]) => isMeasured(kind))
    .map(([kind, ids]) => `${EVIDENCE_LABELS[kind] ?? kind}${fmtIds(ids)}`)
    .join('; ');
}

function fmtStatements(statements: ProteinStatement[]): string[] {
  if (!statements.length) return ['- No statement in this entry.'];
  return measuredFirst(statements, (statement) =>
    statement.evidence.some(({ kind }) => isMeasured(kind))
  ).map((statement) => {
    const qualifiers = [
      statement.topology && `topology: ${statement.topology}`,
      statement.orientation && `orientation: ${statement.orientation}`,
    ]
      .filter(Boolean)
      .join('; ');
    return [
      '- ',
      statement.molecule ? `[molecule: ${statement.molecule}] ` : '',
      statement.note ? 'Note: ' : '',
      statement.text.replace(/\.$/, ''),
      qualifiers ? ` (${qualifiers})` : '',
      `. ${fmtEvidence(statement.evidence)}`,
    ].join('');
  });
}

function fmtProtein(notice: string, protein: ProteinEntry): string {
  const ids = protein.gene
    ? `${protein.gene} (${protein.accession}, ${protein.entryName})`
    : `${protein.accession} (${protein.entryName})`;
  const lines = [
    `# ${ids}, ${protein.organism.scientificName}`,
    `${protein.name}. Matched by ${MATCHED_BY_LABELS[protein.matchedBy] ?? protein.matchedBy}.`,
    '',
    'Subcellular location',
    ...fmtStatements(protein.subcellularLocation),
    'GO cellular component (experimental)',
    ...(protein.goCellularComponent.length
      ? protein.goCellularComponent.map(
          (go) =>
            `- ${go.term} (${go.id}), ${go.code}, ${go.assignedBy}${fmtIds(go.paperIds)}`
        )
      : ['- No experimental term in this entry.']),
    'Function',
    ...fmtStatements(protein.function),
  ];
  if (protein.paperIds.length) {
    lines.push(
      'Open a cited paper with `firecrawl research inspect-paper <paperId>` or `firecrawl research read-paper <paperId> --question <question>`.'
    );
  }
  lines.push(`Source: ${protein.url}. ${notice}`);
  return lines.join('\n');
}

function fmtProteinLookup(protein: string, data: ProteinLookup): string {
  switch (data.match) {
    case 'found':
      return fmtProtein(data.notice, data.protein);
    case 'ambiguous': {
      const { candidates, candidateCount } = data;
      const listed =
        candidateCount > candidates.length
          ? `${candidateCount} candidates, the first ${candidates.length} listed`
          : `${candidateCount} ${candidateCount === 1 ? 'candidate' : 'candidates'}`;
      return [
        `${JSON.stringify(protein)} does not resolve to one UniProtKB/Swiss-Prot entry in the requested organism (human unless --organism is set). ${listed}, as accession, entry name, gene, name, organism:`,
        ...candidates.map(
          (candidate) =>
            `- ${[candidate.accession, candidate.entryName, candidate.gene ?? '-', candidate.name, candidate.organism.scientificName].join(', ')}`
        ),
        'Run `firecrawl research lookup-protein` again with one accession.',
        data.notice,
      ].join('\n');
    }
    case 'not_found':
      return `No UniProtKB/Swiss-Prot entry matches ${JSON.stringify(protein)}. Pass a UniProt accession (P05771), an entry name (KPCB_HUMAN), or a gene symbol with --organism. Only reviewed entries are covered. For a free-text question, use \`firecrawl research search-papers\`.`;
    default:
      throw new Error(
        `The protein lookup returned an unexpected response (match: ${JSON.stringify((data as { match?: unknown }).match)}).`
      );
  }
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

export async function handleLookupProteinCommand(
  options: LookupProteinOptions
): Promise<void> {
  try {
    const params = new URLSearchParams();
    appendParam(params, 'protein', options.protein);
    appendParam(params, 'organism', options.organism);
    const data = await getResearch<ProteinLookup>(
      withQuery(`${BASE}/proteins`, params),
      options
    );
    writeResearchOutput(data, fmtProteinLookup(options.protein, data), options);
  } catch (error) {
    handleError(error);
  }
}
