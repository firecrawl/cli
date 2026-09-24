import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI compatibility aliases', { timeout: 30000 }, () => {
  const cliPath = resolve(process.cwd(), 'dist/index.js');
  const testWithBuiltCli = existsSync(cliPath) ? it : it.skip;

  function run(args: string[]) {
    const script = `
      const auth = require('./dist/utils/auth');
      auth.isAuthenticated = () => false;
      auth.ensureAuthenticated = async () => console.log('AUTH_CHECK');
      require('./dist/utils/credentials').loadCredentials = () => null;
      global.fetch = () => { throw new Error('Unexpected network request'); };
      const print = (value) => console.log(JSON.stringify(value));
      require('./dist/commands/credit-usage').handleCreditUsageCommand = print;
      const scrape = require('./dist/commands/scrape');
      scrape.handleScrapeCommand = print;
      scrape.handleAllScrapeCommand = (_url, options) => print(options);
      require('./dist/commands/parse').handleParseCommand = print;
      require('./dist/commands/crawl').handleCrawlCommand = print;
      require('./dist/commands/agent').handleAgentCommand = print;
      process.argv = [process.execPath, ${JSON.stringify(cliPath)}, ...${JSON.stringify(args)}];
      require(${JSON.stringify(cliPath)});
    `;
    return spawnSync(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        FIRECRAWL_API_KEY: '',
        FIRECRAWL_NO_UPDATE_CHECK: '1',
      },
    });
  }

  testWithBuiltCli(
    'credits preserves credit-usage options and authentication',
    () => {
      const flags = ['--json', '--pretty', '-o', 'credits.json'];
      const canonical = run(['credit-usage', ...flags]);
      const alias = run(['credits', ...flags]);
      expect(alias.status).toBe(0);
      expect(alias.stdout).toBe(canonical.stdout);
      expect(alias.stdout).toContain('AUTH_CHECK');
      expect(alias.stdout).toContain('"output":"credits.json"');
    }
  );

  testWithBuiltCli(
    'status shows the existing unauthenticated overview without login',
    () => {
      const canonical = run(['--status']);
      const alias = run(['status']);
      expect(alias.status).toBe(0);
      expect(alias.stdout).toBe(canonical.stdout);
      expect(alias.stdout).toContain('Not authenticated');
      expect(alias.stdout).not.toContain('AUTH_CHECK');
    }
  );

  testWithBuiltCli.each([
    ['scrape', 'https://example.com'],
    ['https://example.com'],
    ['experimental', 'download', 'https://example.com'],
    ['parse', './report.pdf'],
  ])('accepts --formats for %j', (...command) => {
    const canonical = run([...command, '--format', 'markdown,links']);
    const alias = run([...command, '--formats=markdown,links']);
    expect(alias.status, alias.stderr).toBe(0);
    expect(alias.stdout).toBe(canonical.stdout);
    expect(alias.stdout).toContain('"formats":["markdown","links"]');
  });

  testWithBuiltCli.each(['crawl', 'agent'])(
    'preserves %s job status',
    (command) => {
      const result = run([
        command,
        '12345678-1234-1234-1234-123456789abc',
        '--status',
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('"status":true');
      expect(result.stdout).not.toContain('Not authenticated');
    }
  );
});
