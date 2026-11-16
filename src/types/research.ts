export interface ResearchBaseOptions {
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
  pretty?: boolean;
}

export interface SearchPapersOptions extends ResearchBaseOptions {
  query: string;
  k?: number;
  authors?: string[];
  categories?: string[];
  from?: string;
  to?: string;
  sort?: 'relevance' | 'date_desc';
}

export interface InspectPaperOptions extends ResearchBaseOptions {
  paperId: string;
}

export interface RelatedPapersOptions extends ResearchBaseOptions {
  seedIds: string[];
  intent: string;
  mode?: 'similar' | 'citers' | 'references';
  k?: number;
  rerank?: boolean;
}

export interface ReadPaperOptions extends ResearchBaseOptions {
  paperId: string;
  question: string;
  k?: number;
}

export interface LookupProteinOptions extends ResearchBaseOptions {
  protein: string;
  organism?: string;
}

export type EvidenceKind =
  | 'experimental'
  | 'large_scale_experimental'
  | 'author_statement'
  | 'curator_inference'
  | 'by_similarity'
  | 'sequence_analysis'
  | 'imported'
  | 'untagged';

export type ProteinMatchedBy =
  | 'accession'
  | 'secondary_accession'
  | 'entry_name'
  | 'gene'
  | 'synonym'
  | 'name';

export interface ProteinEvidence {
  kind: EvidenceKind;
  eco?: string;
  paperId?: string;
  fromProtein?: string;
}

export interface ProteinStatement {
  text: string;
  note: boolean;
  molecule?: string;
  topology?: string;
  orientation?: string;
  evidence: ProteinEvidence[];
}

export interface ProteinGoTerm {
  id: string;
  term: string;
  code: string;
  assignedBy: string;
  paperIds: string[];
}

export interface ProteinCandidate {
  accession: string;
  entryName: string;
  gene?: string;
  name: string;
  organism: { taxonId: number; scientificName: string; commonName?: string };
  matchedBy: ProteinMatchedBy;
}

export interface ProteinEntry extends ProteinCandidate {
  synonyms: string[];
  url: string;
  subcellularLocation: ProteinStatement[];
  function: ProteinStatement[];
  goCellularComponent: ProteinGoTerm[];
  paperIds: string[];
}

export type ProteinLookup = {
  success: true;
  release: string;
  notice: string;
} & (
  | { match: 'found'; protein: ProteinEntry }
  | {
      match: 'ambiguous';
      candidates: ProteinCandidate[];
      candidateCount: number;
    }
  | { match: 'not_found' }
);

export interface PaperHit {
  paperId?: string;
  primaryId?: string;
  ids?: Record<string, string[]>;
  title?: string;
  abstract?: string;
  authors?: string | string[];
  categories?: string[];
  createdDate?: string;
  updateDate?: string;
  signals?: Record<string, unknown>;
  score?: number;
}
