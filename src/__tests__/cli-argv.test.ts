import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI argv parsing', () => {
  const cliPath = resolve(process.cwd(), 'dist/index.js');
  const testWithBuiltCli = existsSync(cliPath) ? it : it.skip;

  testWithBuiltCli('rejects invalid PDF page caps before scraping', () => {
    for (const value of ['0', '10001', '2.5', '3pages']) {
      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          'scrape',
          'https://example.com/report.pdf',
          '--max-pages',
          value,
        ],
        { encoding: 'utf8' }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must be an integer between 1 and 10000');
    }
  });

  testWithBuiltCli(
    'documents the PDF cap and per-page price in scrape help',
    () => {
      const result = spawnSync(
        process.execPath,
        [cliPath, 'scrape', '--help'],
        { encoding: 'utf8' }
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('--max-pages');
      expect(result.stdout.replace(/\s+/g, ' ')).toContain(
        '1 credit per parsed page'
      );
    }
  );

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
    expect(result.stdout.replace(/\s+/g, ' ')).toContain('public repositories');
    // Lean surface: the CLI does not point at the REST API for filters.
    expect(result.stdout).not.toContain('docs.firecrawl.dev');
    expect(result.stderr).not.toContain('unknown command');
  });

  testWithBuiltCli(
    'describes default search highlights and public developer coverage',
    () => {
      const result = spawnSync(
        process.execPath,
        [cliPath, 'search', '--help'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        }
      );

      expect(result.status).toBe(0);
      const flattened = result.stdout.replace(/\s+/g, ' ');
      expect(flattened).toContain(
        'Search the web with query-relevant highlights and discover relevant Alexandria tools'
      );
      expect(flattened).toContain(
        'Return query-relevant page excerpts for web and news results when available (default).'
      );
      expect(flattened).toContain('public repositories');
      expect(flattened).toContain('research, pdf, developer');
      expect(flattened).not.toContain('github, research');
    }
  );

  testWithBuiltCli('rejects the github search category', () => {
    const result = spawnSync(
      process.execPath,
      [cliPath, 'search', 'tokio', '--categories', 'github'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid category "github"');
    expect(result.stderr).toContain('research, pdf, developer');
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
