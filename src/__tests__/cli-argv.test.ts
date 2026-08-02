import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI argv parsing', () => {
  const cliPath = resolve(process.cwd(), 'dist/index.js');
  const testWithBuiltCli = existsSync(cliPath) ? it : it.skip;

  testWithBuiltCli('lists the developer command in root help output', () => {
    const result = spawnSync(process.execPath, [cliPath, '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s*developer\b/m);
  });

  testWithBuiltCli('parses the developer command and shows its help', () => {
    const result = spawnSync(
      process.execPath,
      [cliPath, 'developer', '--help'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: firecrawl developer');
    expect(result.stdout).toContain('--limit');
    expect(result.stdout).toContain('--skills-only');
    expect(result.stderr).not.toContain('unknown command');
  });

  testWithBuiltCli(
    'parses subcommands when a wrapper leaves the entry script path in argv',
    () => {
      const script = `
        process.argv.splice(1, 0, ${JSON.stringify(cliPath)});
        require(process.argv[1]);
      `;

      const result = spawnSync(
        process.execPath,
        ['-e', script, 'setup', '--help'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Usage: firecrawl setup');
      expect(result.stderr).not.toContain('unknown command');
    }
  );
});
