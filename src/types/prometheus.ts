/**
 * Types for the `prometheus` command group — a thin client over a Prometheus
 * instance's /api/v1 surface (the same contract as the reference CLI in the
 * prometheus repo, cli/bin.mjs).
 */

/** Options shared by every Prometheus command. */
export interface PrometheusCommonOptions {
  /** Firecrawl API key, forwarded as X-Firecrawl-Key (falls back to global config). */
  apiKey?: string;
  /** Prometheus instance base URL (overrides PROMETHEUS_API_URL / PROMETHEUS_URL). */
  prometheusUrl?: string;
  /** Emit raw JSON instead of human-formatted output. */
  json?: boolean;
}

export interface PrometheusBuildOptions extends PrometheusCommonOptions {
  /** Path to a JSON schema file to constrain the output. */
  schema?: string;
  /** Target URLs to seed the build. */
  url?: string[];
  /** Model override, "provider:id" or "id". */
  model?: string;
  /** Output directory for script.ts + sample.json (human mode). */
  output?: string;
}

export interface PrometheusFeedCreateOptions extends PrometheusCommonOptions {
  every?: string;
  name?: string;
  heal?: string;
  session?: string;
  schema?: string;
}

/** The integration block returned by /build. */
export interface BuildIntegration {
  dependencies: string[];
  run: string;
  env: string[];
}

/** Response from POST /api/v1/build. */
export interface BuildResult {
  sessionId: string;
  script: string;
  sample: unknown;
  rowCount: number;
  summary?: string;
  howItWorks?: string;
  expectedOutput?: string;
  integration: BuildIntegration;
}

export interface FeedSchedule {
  description: string;
  cron?: string;
}

export interface FeedRun {
  status: string;
  kind: string;
  rowCount?: number | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface Feed {
  id: string;
  name: string;
  summary?: string;
  schedule: FeedSchedule;
  enabled: boolean;
  selfHeal?: string;
  health: 'healthy' | 'failing' | 'healing' | 'pending' | string;
  nextRunAt?: string | null;
  latestRun?: { rowCount?: number | null } | null;
}
