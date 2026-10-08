export interface GovSearchOptions {
  query: string;
  k?: number;
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
  pretty?: boolean;
}

export interface GovResult {
  url: string;
  title?: string;
  description?: string;
  position?: number;
}

export interface GovSearchResponse {
  success: boolean;
  error?: string;
  data?: { web?: GovResult[] };
}
