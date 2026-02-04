/**
 * Types and interfaces for the agent command
 */

export type AgentModel = 'spark-1-pro' | 'spark-1-mini';

export type AgentStatus = 'processing' | 'completed' | 'failed';

export interface AgentOptions {
  /** Natural language prompt describing the data to extract */
  prompt: string;
  /** Model to use: spark-1-mini (default, cheaper) or spark-1-pro (higher accuracy) */
  model?: AgentModel;
  /** Specific URLs to focus extraction on */
  urls?: string[];
  /** JSON schema for structured output */
  schema?: Record<string, unknown>;
  /** Path to JSON schema file */
  schemaFile?: string;
  /** Maximum credits to spend (job fails if exceeded) */
  maxCredits?: number;
  /** Check status of existing agent job */
  status?: boolean;
  /** Wait for agent to complete before returning results */
  wait?: boolean;
  /** Polling interval in seconds when waiting */
  pollInterval?: number;
  /** Timeout in seconds when waiting */
  timeout?: number;
  /** API key for Firecrawl */
  apiKey?: string;
  /** API URL for Firecrawl */
  apiUrl?: string;
  /** Output file path */
  output?: string;
  /** Pretty print JSON output */
  pretty?: boolean;
  /** Force JSON output */
  json?: boolean;
}

export interface AgentResult {
  success: boolean;
  data?: {
    jobId: string;
    status: AgentStatus;
  };
  error?: string;
}

export interface AgentStatusResult {
  success: boolean;
  data?: {
    id: string;
    status: AgentStatus;
    data?: any;
    creditsUsed?: number;
    expiresAt?: string;
  };
  error?: string;
}
