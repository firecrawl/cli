/**
 * Utility functions for job ID detection and validation
 */

/**
 * Check if a string looks like a UUID/job ID
 * Firecrawl job IDs are UUIDs (v4 or v7)
 */
export function isJobId(str: string): boolean {
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidPattern.test(str);
}

/**
 * Check if a string is a valid URL
 */
export function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}
