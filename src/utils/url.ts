/**
 * URL utility functions
 */

/**
 * Check if a string looks like a URL (with or without protocol)
 */
export function isUrl(str: string): boolean {
  // If it has a protocol, validate it
  if (/^https?:\/\//i.test(str)) {
    try {
      const url = new URL(str);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return true; // Assume valid if it starts with http:// or https://
    }
  }

  // Check if it looks like a domain (has dots and valid characters)
  // Exclude common commands and flags
  if (str.includes('.') && !str.startsWith('-') && !str.includes(' ')) {
    // Basic domain validation: contains at least one dot and valid characters
    const domainPattern =
      /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}(\/.*)?$/;
    return domainPattern.test(str);
  }

  return false;
}

/**
 * Normalize URL by adding https:// if missing
 */
export function normalizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `https://${url}`;
}
