import { describe, expect, it } from 'vitest';
import { isPrerelease, satisfiesRange } from '../../utils/npm-registry';

describe('isPrerelease', () => {
  it('flags versions with a prerelease tag', () => {
    expect(isPrerelease('1.26.24-beta.23')).toBe(true);
    expect(isPrerelease('2.0.0-beta.1')).toBe(true);
    expect(isPrerelease('1.26.24')).toBe(false);
  });
});

describe('satisfiesRange', () => {
  it('handles the comparator forms engines.node uses', () => {
    expect(satisfiesRange('24.22.1', '>=22.0.0')).toBe(true);
    expect(satisfiesRange('20.11.0', '>=22.0.0')).toBe(false);
    expect(satisfiesRange('24.22.1', '>=99')).toBe(false);
    expect(satisfiesRange('22.5.0', '>=22 <23')).toBe(true);
    expect(satisfiesRange('23.0.0', '>=22 <23')).toBe(false);
    expect(satisfiesRange('20.12.0', '^20.10 || >=22')).toBe(true);
    expect(satisfiesRange('21.0.0', '^20.10 || >=22')).toBe(false);
    expect(satisfiesRange('22.5.1', '~22.5.0')).toBe(true);
    expect(satisfiesRange('22.6.0', '~22.5.0')).toBe(false);
    expect(satisfiesRange('22.9.0', '22.x')).toBe(true);
    expect(satisfiesRange('24.0.0', '*')).toBe(true);
  });

  it('reads spaced operators and partial bounds the way npm does', () => {
    expect(satisfiesRange('22.5.0', '>= 22')).toBe(true);
    expect(satisfiesRange('22.5.0', '>22')).toBe(false);
    expect(satisfiesRange('23.0.0', '>22')).toBe(true);
    expect(satisfiesRange('22.5.0', '<=22')).toBe(true);
    expect(satisfiesRange('23.0.0', '<=22')).toBe(false);
    expect(satisfiesRange('22.1.9', '>22.1')).toBe(false);
    expect(satisfiesRange('22.2.0', '>22.1')).toBe(true);
    expect(satisfiesRange('22.5.0', '> 22.4.9')).toBe(true);
  });

  it('treats syntax it does not recognize as unsatisfied', () => {
    expect(satisfiesRange('24.22.1', '22 - 24')).toBe(false);
    expect(satisfiesRange('24.22.1', 'latest')).toBe(false);
  });
});
