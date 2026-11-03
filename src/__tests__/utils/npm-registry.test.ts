import { describe, expect, it } from 'vitest';
import { isPrerelease } from '../../utils/npm-registry';

describe('isPrerelease', () => {
  it('flags versions with a prerelease tag', () => {
    expect(isPrerelease('1.26.24-beta.23')).toBe(true);
    expect(isPrerelease('2.0.0-beta.1')).toBe(true);
    expect(isPrerelease('1.26.24')).toBe(false);
  });
});
