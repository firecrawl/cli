/**
 * Firecrawl client utility
 * Provides a singleton client instance initialized with global configuration
 */

import { Firecrawl } from 'firecrawl';
import type { FirecrawlClientOptions } from 'firecrawl';
import {
  getConfig,
  validateConfig,
  updateConfig,
  type GlobalConfig,
} from './config';

let clientInstance: Firecrawl | null = null;

/**
 * Get or create the Firecrawl client instance
 * Uses global configuration if available, otherwise creates with provided options
 */
export function getClient(
  options?: Partial<FirecrawlClientOptions>
): Firecrawl {
  // Helper to convert null to undefined and ensure we have a string or undefined
  const normalizeApiKey = (
    value: string | null | undefined
  ): string | undefined =>
    value === null || value === undefined ? undefined : value;

  // If options provided, update global config and create a new instance
  if (options) {
    // Update global config with provided options (for future calls)
    // Only include properties that are explicitly provided (not undefined)
    const configUpdate: Partial<GlobalConfig> = {};
    if (options.apiKey !== undefined) {
      configUpdate.apiKey = normalizeApiKey(options.apiKey);
    }
    if (options.apiUrl !== undefined) {
      configUpdate.apiUrl = normalizeApiKey(options.apiUrl);
    }
    if (options.timeoutMs !== undefined) {
      configUpdate.timeoutMs = options.timeoutMs;
    }
    if (options.maxRetries !== undefined) {
      configUpdate.maxRetries = options.maxRetries;
    }
    if (options.backoffFactor !== undefined) {
      configUpdate.backoffFactor = options.backoffFactor;
    }

    if (Object.keys(configUpdate).length > 0) {
      updateConfig(configUpdate);
    }

    const config = getConfig();
    const apiKey = normalizeApiKey(options.apiKey) ?? config.apiKey;
    const apiUrl = normalizeApiKey(options.apiUrl) ?? config.apiUrl;

    // Normalize apiKey for validation (convert null to undefined)
    const normalizedApiKey = apiKey === null ? undefined : apiKey;
    validateConfig(normalizedApiKey);

    const clientOptions: FirecrawlClientOptions = {
      apiKey: normalizedApiKey || undefined,
      apiUrl: apiUrl === null ? undefined : apiUrl,
      timeoutMs: options.timeoutMs ?? config.timeoutMs,
      maxRetries: options.maxRetries ?? config.maxRetries,
      backoffFactor: options.backoffFactor ?? config.backoffFactor,
    };

    return new Firecrawl(clientOptions);
  }

  // Return singleton instance or create one
  if (!clientInstance) {
    const config = getConfig();
    validateConfig(config.apiKey);

    const clientOptions: FirecrawlClientOptions = {
      apiKey: config.apiKey || undefined,
      apiUrl: config.apiUrl || undefined,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      backoffFactor: config.backoffFactor,
    };

    clientInstance = new Firecrawl(clientOptions);
  }

  return clientInstance;
}

/**
 * Initialize the client with configuration
 * This should be called early in the application lifecycle
 */
export function initializeClient(config?: Partial<GlobalConfig>): Firecrawl {
  if (config) {
    const { initializeConfig } = require('./config');
    initializeConfig(config);
  }

  // Reset instance to force recreation with new config
  clientInstance = null;
  return getClient();
}

/**
 * Reset the client instance (useful for testing)
 */
export function resetClient(): void {
  clientInstance = null;
}
