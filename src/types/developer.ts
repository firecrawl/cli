export interface DeveloperSearchOptions {
  query: string;
  k?: number;
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
  pretty?: boolean;
}

export interface DeveloperLicense {
  state: 'licensed' | 'known_absent' | 'unknown';
  spdx_id: string | null;
}

export interface DeveloperItem {
  id: string;
  url: string;
  title?: string;
  passages: { text: string; citation_url?: string }[];
  // Accept both shapes while the API flattens license disclosures to SPDX strings.
  license?: DeveloperLicense | string;
}

export interface DeveloperRepoStatus {
  repo: string;
  indexed: boolean;
  types: { issue: boolean; pullRequest: boolean; readme: boolean };
}

export interface DeveloperSourceStatus {
  source: string;
  indexed: boolean;
}

export interface DeveloperSearchResponse {
  success: boolean;
  // Tolerated wire shape: treated as optional at runtime (`?? []`).
  results?: DeveloperItem[];
  repos?: DeveloperRepoStatus[];
  sources?: DeveloperSourceStatus[];
}
