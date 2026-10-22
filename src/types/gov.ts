export interface GovSearchOptions {
  query: string;
  k?: number;
  jurisdiction?: string;
  court?: string;
  courtType?: string;
  cites?: string;
  domain?: string;
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
