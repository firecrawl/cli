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
    for (const removedFilter of [
      '--passages',
      '--types',
      '--repos',
      '--sources',
      '--language',
      '--topic',
      '--license',
      '--min-stars',
      '--max-stars',
      '--archived',
      '--fork',
      '--skills-only',
      '--passage-budget',
    ]) {
      expect(result.stdout).not.toContain(removedFilter);
    }
    expect(result.stdout).toContain('scoping intent in');
    // Lean surface: the CLI does not point at the REST API for filters.
    expect(result.stdout).not.toContain('docs.firecrawl.dev');
    expect(result.stderr).not.toContain('unknown command');
  });

  testWithBuiltCli('lists the research command in root help output', () => {
    const result = spawnSync(process.execPath, [cliPath, '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\s*research\b/m);
  });

  testWithBuiltCli('parses the research command and shows its help', () => {
    const result = spawnSync(
      process.execPath,
      [cliPath, 'research', '--help'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: firecrawl research');
    expect(result.stdout).toContain('search-papers');
    expect(result.stdout).toContain('read-paper');
    expect(result.stderr).not.toContain('unknown command');
  });

  testWithBuiltCli(
    'describes the research index by its real corpus, not just arXiv',
    () => {
      const result = spawnSync(process.execPath, [cliPath, '--help'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^\s*research\b/m);
      // Collapse wrapping so the assertion does not depend on terminal width.
      const flattened = result.stdout.replace(/\s+/g, ' ');
      expect(flattened).toContain('PubMed');
      expect(flattened).toContain('biomedical');
    }
  );

  testWithBuiltCli('exposes the agent thread flags and subcommand', () => {
    const result = spawnSync(process.execPath, [cliPath, 'agent', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const flattened = result.stdout.replace(/\s+/g, ' ');
    for (const flag of [
      '--thread',
      '--continue',
      '--new',
      '--mode',
      '--effort',
      '--exchange',
      '--toolkits',
      '--max-calls',
      '--require-approval',
      '--approve',
      '--decline',
    ]) {
      expect(flattened).toContain(flag);
    }
    expect(flattened).toContain('thread [options] <threadId>');
    expect(result.stderr).not.toContain('unknown command');
  });

  testWithBuiltCli('offers flags that clear inherited URLs and schema', () => {
    const result = spawnSync(process.execPath, [cliPath, 'agent', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    const flattened = result.stdout.replace(/\s+/g, ' ');
    expect(flattened).toContain('--no-urls');
    expect(flattened).toContain('--no-schema');
  });

  testWithBuiltCli('requires a thread to clear URLs or schema', () => {
    for (const flag of ['--no-urls', '--no-schema']) {
      const result = spawnSync(
        process.execPath,
        [cliPath, 'agent', flag, 'a prompt'],
        { cwd: process.cwd(), encoding: 'utf8' }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'only apply to a follow-up. Pass --thread <id> or --continue.'
      );
    }
  });

  testWithBuiltCli('rejects clearing a value that is also being set', () => {
    const urls = spawnSync(
      process.execPath,
      [
        cliPath,
        'agent',
        '--continue',
        '--urls',
        'https://example.com',
        '--no-urls',
        'a prompt',
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    );

    expect(urls.status).toBe(1);
    expect(urls.stderr).toContain('use --urls or --no-urls, not both.');

    const schema = spawnSync(
      process.execPath,
      [
        cliPath,
        'agent',
        '--continue',
        '--schema',
        '{"type":"object"}',
        '--no-schema',
        'a prompt',
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    );

    expect(schema.status).toBe(1);
    expect(schema.stderr).toContain(
      'use --schema/--schema-file or --no-schema, not both.'
    );
  });

  testWithBuiltCli('parses the agent thread subcommand', () => {
    const result = spawnSync(
      process.execPath,
      [cliPath, 'agent', 'thread', '--help'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: firecrawl agent thread');
    expect(result.stderr).not.toContain('unknown command');
  });

  testWithBuiltCli(
    'exposes explicit keyless MCP setup and launch flags',
    () => {
      const setup = spawnSync(process.execPath, [cliPath, 'setup', '--help'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      const launch = spawnSync(
        process.execPath,
        [cliPath, 'launch', '--help'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        }
      );

      expect(setup.status).toBe(0);
      expect(setup.stdout).toContain('--keyless');
      expect(launch.status).toBe(0);
      expect(launch.stdout).toContain('--keyless');
    }
  );

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
