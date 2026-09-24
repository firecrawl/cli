import { describe, expect, it } from 'vitest';
import { detectPackageManager } from '../../utils/package-manager';

describe('package manager detection', () => {
  it.each([
    [{ npm_config_user_agent: 'npm/10.9.0 node/v22.0.0' }, 'npm'],
    [{ npm_config_user_agent: 'pnpm/10.12.1 npm/? node/v22.0.0' }, 'pnpm'],
    [{ npm_config_user_agent: 'bun/1.3.0' }, 'bun'],
    [{ npm_execpath: '/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs' }, 'pnpm'],
    [{ npm_execpath: '/home/user/.bun/bin/bun' }, 'bun'],
    [{}, 'npm'],
  ] as const)('detects %j as %s', (env, expected) => {
    expect(detectPackageManager(env, ['node', '/app/firecrawl'], {})).toBe(
      expected
    );
  });

  it.each([
    [
      '/private/tmp/bunx-501-firecrawl-cli@latest/node_modules/firecrawl-cli/dist/index.js',
      'bun',
    ],
    [
      '/home/user/.cache/pnpm/dlx/123/node_modules/firecrawl-cli/dist/index.js',
      'pnpm',
    ],
    [
      '/home/user/.local/share/pnpm/global/5/node_modules/firecrawl-cli/dist/index.js',
      'pnpm',
    ],
    [
      'C:\\Users\\user\\AppData\\Local\\pnpm\\global\\5\\node_modules\\firecrawl-cli\\dist\\index.js',
      'pnpm',
    ],
  ])(
    'prefers install or runner path %s over inherited npm metadata',
    (entry, expected) => {
      expect(
        detectPackageManager({ npm_config_user_agent: 'npm/2.15.12' }, [
          'node',
          entry,
        ])
      ).toBe(expected);
    }
  );

  it('detects a direct Bun invocation without package manager metadata', () => {
    expect(
      detectPackageManager({}, ['bun', '/app/dist/index.js'], { bun: '1.3.0' })
    ).toBe('bun');
  });
});
