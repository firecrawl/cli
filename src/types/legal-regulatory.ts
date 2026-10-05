export interface LegalRegulatorySearchOptions {
  query: string;
  k?: number;
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
  pretty?: boolean;
}

export interface LegalRegulatoryResult {
  url: string;
  title?: string;
  description?: string;
  position?: number;
}

export interface LegalRegulatorySearchResponse {
  success: boolean;
  error?: string;
  data?: { web?: LegalRegulatoryResult[] };
}
