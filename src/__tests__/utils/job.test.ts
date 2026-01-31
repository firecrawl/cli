/**
 * Tests for job utility functions
 */

import { describe, it, expect } from 'vitest';
import { isJobId, isValidUrl } from '../../utils/job';

describe('isJobId', () => {
  it('should return true for valid UUID formats', () => {
    // UUID v4
    expect(isJobId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isJobId('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
    expect(isJobId('00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(isJobId('ffffffff-ffff-4fff-8fff-ffffffffffff')).toBe(true);
    // UUID v7 (Firecrawl uses this)
    expect(isJobId('019c0ed5-126b-7581-90f1-894a349a1e9d')).toBe(true);
  });

  it('should return false for invalid UUID formats', () => {
    expect(isJobId('not-a-uuid')).toBe(false);
    expect(isJobId('550e8400-e29b-41d4-a716')).toBe(false);
    expect(isJobId('550e8400-e29b-41d4-a716-446655440000-extra')).toBe(false);
    expect(isJobId('')).toBe(false);
  });

  it('should return false for URLs', () => {
    expect(isJobId('https://example.com')).toBe(false);
    expect(isJobId('http://example.com/page')).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isJobId('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    expect(isJobId('550e8400-E29b-41d4-A716-446655440000')).toBe(true);
  });
});

describe('isValidUrl', () => {
  it('should return true for valid HTTP URLs', () => {
    expect(isValidUrl('http://example.com')).toBe(true);
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('https://example.com/path')).toBe(true);
    expect(isValidUrl('https://example.com/path?query=value')).toBe(true);
    expect(isValidUrl('https://example.com:8080/path')).toBe(true);
  });

  it('should return false for invalid URLs', () => {
    expect(isValidUrl('not-a-url')).toBe(false);
    expect(isValidUrl('example.com')).toBe(false);
    expect(isValidUrl('')).toBe(false);
    expect(isValidUrl('ftp://example.com')).toBe(true); // Still valid URL
  });

  it('should handle edge cases', () => {
    expect(isValidUrl('http://')).toBe(false);
    expect(isValidUrl('https://')).toBe(false);
  });
});
