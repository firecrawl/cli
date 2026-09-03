/**
 * Global configuration system
 */

import * as path from 'path';
import { getConfigDirectoryPath, loadCredentials } from './credentials';

export interface GlobalConfig {
  apiKey?: string;
  apiUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  backoffFactor?: number;
}

/**
 * Global configuration instance
 */
let globalConfig: GlobalConfig = {};

/**
 * Initialize global configuration
 * Loads from: provided config > environment variables > OS credential storage
 * @param config Configuration options
 */
export function initializeConfig(config: Partial<GlobalConfig> = {}): void {
  // Priority: provided config > env vars > stored credentials
  const storedCredentials = loadCredentials();

  globalConfig = {
    apiKey:
      config.apiKey ||
      process.env.FIRECRAWL_API_KEY ||
      storedCredentials?.apiKey,
    apiUrl:
      config.apiUrl ||
      process.env.FIRECRAWL_API_URL ||
      storedCredentials?.apiUrl,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    backoffFactor: config.backoffFactor,
  };
}

/**
 * Get the current global configuration
 */
export function getConfig(): GlobalConfig {
  return { ...globalConfig };
}

/**
 * Update global configuration (merges with existing)
 */
export function updateConfig(config: Partial<GlobalConfig>): void {
  globalConfig = {
    ...globalConfig,
    ...config,
  };
}

/**
 * Get API key from global config or provided value
 * Priority: provided key > global config > env var > stored credentials
 */
export function getApiKey(providedKey?: string): string | undefined {
  if (providedKey) return providedKey;
  if (globalConfig.apiKey) return globalConfig.apiKey;
  if (process.env.FIRECRAWL_API_KEY) return process.env.FIRECRAWL_API_KEY;

  // Fallback to stored credentials if not already loaded
  const storedCredentials = loadCredentials();
  return storedCredentials?.apiKey;
}

export const DEFAULT_API_URL = 'https://api.firecrawl.dev';

/**
 * One server, however its URL was spelled. Host casing and a trailing slash
 * are not a different server, and both whether a key is required and which
 * thread memory bucket a run belongs to turn on the answer.
 */
export function normalizeApiUrl(apiUrl?: string): string {
  const raw = apiUrl?.trim() || DEFAULT_API_URL;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return raw.replace(/\/$/, '').toLowerCase();
  }
}

/** Whether a URL reaches Firecrawl's cloud API rather than a self-hosted one. */
export function isDefaultApiUrl(apiUrl?: string): boolean {
  return normalizeApiUrl(apiUrl) === normalizeApiUrl(DEFAULT_API_URL);
}

/**
 * Check if using a custom (non-cloud) API URL
 */
export function isCustomApiUrl(apiUrl?: string): boolean {
  const url = apiUrl || globalConfig.apiUrl;
  // Compared through the normalizer: a differently cased or trailing-slashed
  // cloud URL is still the cloud, and reading it as self-hosted waives the
  // key requirement and sends the request with no Authorization header.
  return !!url && !isDefaultApiUrl(url);
}

/**
 * Validate that required configuration is present
 * API key is only required for the cloud API, not for local/custom APIs
 */
export function validateConfig(apiKey?: string): void {
  // Skip API key validation for custom API URLs (e.g., local development)
  if (isCustomApiUrl()) {
    return;
  }

  const key = getApiKey(apiKey);
  if (!key) {
    throw new Error(
      'API key is required. Set FIRECRAWL_API_KEY environment variable, use --api-key flag, or run "firecrawl config" to set the API key.'
    );
  }
}

/**
 * Path of the remembered agent threads file, next to credentials.json,
 * browser-session.json and interact-session.json
 */
export function getAgentThreadsPath(): string {
  return path.join(getConfigDirectoryPath(), 'agent-threads.json');
}

/**
 * Reset global configuration (useful for testing)
 */
export function resetConfig(): void {
  globalConfig = {};
}
