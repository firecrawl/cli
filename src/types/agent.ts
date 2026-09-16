/**
 * Types and interfaces for the agent command
 */

import type { AgentMode, AgentSuggestion, AgentWebhookConfig } from 'firecrawl';

export type AgentModel = 'spark-1-pro' | 'spark-1-mini' | 'spark-2';

export type AgentEffort = 'low' | 'medium' | 'high';

export type AgentStatus = 'processing' | 'completed' | 'failed' | 'cancelled';

export interface AgentOptions {
  /** Natural language prompt describing the data to extract */
  prompt: string;
  /** Model to use: spark-2 (default), spark-1-mini, or spark-1-pro */
  model?: AgentModel;
  /** Reasoning effort for the run */
  effort?: AgentEffort;
  /** Continue an existing thread instead of starting a new one */
  threadId?: string;
  /** extract (structured data) or chat (message reply) */
  mode?: AgentMode;
  /** Specific URLs to focus extraction on */
  urls?: string[];
  /** JSON schema for structured output */
  schema?: Record<string, unknown>;
  /** Path to JSON schema file */
  schemaFile?: string;
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
}

export interface AgentResult {
  success: boolean;
  data?: {
    jobId: string;
    status: AgentStatus;
    threadId?: string;
    threadTurn?: number;
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

export interface AgentThreadOptions {
  threadId: string;
  /** Inline each succeeded run's data */
  includeData?: boolean;
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  pretty?: boolean;
  json?: boolean;
}
