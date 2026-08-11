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

export interface SearchGitHubOptions extends ResearchBaseOptions {
  query: string;
  k?: number;
}

export interface PaperHit {
  paperId?: string;
  primaryId?: string;
  ids?: Record<string, string[]>;
  title?: string;
  abstract?: string;
  authors?: string | { name: string; affiliation?: string }[];
  categories?: string[];
  createdDate?: string;
  updateDate?: string;
  signals?: Record<string, unknown>;
  score?: number;
}

export interface GitHubItem {
  repo?: string;
  url?: string;
  pageType?: string;
  number?: number;
  segmentCount?: number;
  readmeUrl?: string;
  title?: string;
  snippet?: string;
  contentMd?: string;
}
