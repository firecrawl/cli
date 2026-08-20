export interface DeveloperSearchOptions {
  query: string;
  k?: number;
  skillsOnly?: boolean;
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
  pretty?: boolean;
}

export interface DeveloperItem {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
  passages?: { text?: string }[];
}
