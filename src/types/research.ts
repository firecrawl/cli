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
