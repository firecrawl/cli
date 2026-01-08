/**
 * Test utilities for mocking the Firecrawl client
 */

import { resetClient } from '../../utils/client';
import { resetConfig } from '../../utils/config';

/**
 * Mock Firecrawl client methods
 * These are typed as any to allow flexible mocking in tests
 */
export interface MockFirecrawlClient {
  scrape: any;
  crawl?: any;
  map?: any;
  extract?: any;
  agent?: any;
}

/**
 * Setup test environment - reset client and config
 */
export function setupTest(): void {
  resetClient();
  resetConfig();
}

/**
 * Teardown test environment
 */
export function teardownTest(): void {
  resetClient();
  resetConfig();
}
