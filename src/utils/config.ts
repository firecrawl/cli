/**
 * Global configuration system
 */

import { loadCredentials } from './credentials';

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

const DEFAULT_API_URL = 'https://api.firecrawl.dev';

/**
 * What to do when a command needs an account and none is configured. Browser
 * login leads because it asks nothing on stdin, so an agent or script can run
 * it; the person only has to open the printed URL.
 */
export const LOGIN_GUIDANCE =
  'Run "firecrawl login --browser" to sign in: it needs no terminal input, prints a sign-in URL for the user to open, and waits up to 5 minutes for approval. Or set FIRECRAWL_API_KEY, or pass --api-key.';

/**
 * Check if using a custom (non-cloud) API URL
 */
export function isCustomApiUrl(apiUrl?: string): boolean {
  const url = apiUrl || globalConfig.apiUrl;
  return !!url && url !== DEFAULT_API_URL;
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
    throw new Error(`Not authenticated. ${LOGIN_GUIDANCE}`);
  }
}

/**
 * Reset global configuration (useful for testing)
 */
export function resetConfig(): void {
  globalConfig = {};
}
