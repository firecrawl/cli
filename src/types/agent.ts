/**
 * Types and interfaces for the agent command
 */

import type { AgentWebhookConfig } from 'firecrawl';

export type AgentModel = 'spark-1-pro' | 'spark-1-mini';

export type AgentStatus = 'processing' | 'completed' | 'failed' | 'cancelled';

export type AgentMode = 'extract' | 'chat';

export type AgentEffort = 'low' | 'medium' | 'high';

/** Follow-up the agent proposes for the next turn */
export interface AgentSuggestion {
  label: string;
  prompt: string;
}

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
  /** Send an empty URL list, clearing URLs inherited from the thread */
  clearUrls?: boolean;
  /** Send a null schema, clearing a schema inherited from the thread */
  clearSchema?: boolean;
  /** Webhook URL or webhook config */
  webhook?: string | AgentWebhookConfig;
  /** Cancel active agent job by ID */
  cancel?: boolean;
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
  /** Continue the thread with this ID */
  thread?: string;
  /** Continue the thread last started with this API key */
  continue?: boolean;
  /** Ignore any remembered thread and start a new one */
  new?: boolean;
  /** Run mode: extract (default, JSON) or chat (the agent may reply in prose) */
  mode?: AgentMode;
  /** How much work the agent should put into the run */
  effort?: AgentEffort;
}

export interface AgentResult {
  success: boolean;
  data?: {
    jobId: string;
    status: AgentStatus;
    threadId?: string;
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
    threadId?: string;
    threadTurn?: number;
    mode?: AgentMode;
    message?: string;
    suggestions?: AgentSuggestion[];
  };
  error?: string;
}

/** One turn of a thread, from GET /v2/agent/threads/:id */
export interface AgentThreadRun {
  id: string;
  turn: number;
  mode?: AgentMode;
  prompt?: string;
  urls?: string[];
  status?: string;
  createdAt?: string;
  finishedAt?: string | null;
  creditsUsed?: number | null;
  message?: string | null;
  data?: unknown;
  suggestions?: AgentSuggestion[] | null;
}

export interface AgentThread {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  runs: AgentThreadRun[];
}

export interface AgentThreadOptions {
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
  pretty?: boolean;
}

export interface AgentThreadResult {
  success: boolean;
  thread?: AgentThread;
  error?: string;
}
