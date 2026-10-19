/**
 * Tests for the integration tag
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getIntegration } from '../../utils/integration';

describe('getIntegration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to cli', () => {
    vi.stubEnv('FIRECRAWL_INTEGRATION', undefined);
    expect(getIntegration()).toBe('cli');
  });

  it('uses FIRECRAWL_INTEGRATION when it starts with an underscore', () => {
    vi.stubEnv('FIRECRAWL_INTEGRATION', '_rtk');
    expect(getIntegration()).toBe('_rtk');
  });

  it('trims surrounding whitespace', () => {
    vi.stubEnv('FIRECRAWL_INTEGRATION', '  _rtk\n');
    expect(getIntegration()).toBe('_rtk');
  });

  it.each(['', '   ', 'rtk', 'zapier', 'cli_', ' x_rtk'])(
    'ignores %j and falls back to cli',
    (value) => {
      vi.stubEnv('FIRECRAWL_INTEGRATION', value);
      expect(getIntegration()).toBe('cli');
    }
  );
});
