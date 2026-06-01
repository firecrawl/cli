/**
 * Tests for the doctor command. Covers:
 *  - version comparison utility
 *  - MCP-entry detection helper
 *  - runChecks() across pass/warn/fail scenarios
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { compareVersions } from '../../utils/npm-registry';
import { hasFirecrawlMcpEntry } from '../../utils/agents';
import { runChecks, runSupportAsk } from '../../commands/doctor';
import { initializeConfig, resetConfig } from '../../utils/config';

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns negative when first is older', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
  });

  it('returns positive when first is newer', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('handles missing parts and v-prefix', () => {
    expect(compareVersions('v1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(0);
  });
});

describe('hasFirecrawlMcpEntry', () => {
  it('detects firecrawl under mcpServers', () => {
    expect(
      hasFirecrawlMcpEntry({
        mcpServers: { firecrawl: { command: 'npx' } },
      })
    ).toBe(true);
  });

  it('detects firecrawl under mcp.servers (VS Code style)', () => {
    expect(
      hasFirecrawlMcpEntry({
        mcp: { servers: { firecrawl: { command: 'npx' } } },
      })
    ).toBe(true);
  });

  it('returns false when no firecrawl entry present', () => {
    expect(
      hasFirecrawlMcpEntry({
        mcpServers: { other: { command: 'npx' } },
      })
    ).toBe(false);
  });

  it('returns false for non-object input', () => {
    expect(hasFirecrawlMcpEntry(null)).toBe(false);
    expect(hasFirecrawlMcpEntry('string')).toBe(false);
    expect(hasFirecrawlMcpEntry(42)).toBe(false);
  });

  it('walks nested objects', () => {
    expect(
      hasFirecrawlMcpEntry({
        projects: {
          '/repo': { mcpServers: { firecrawl: {} } },
        },
      })
    ).toBe(true);
  });
});

describe('runChecks', () => {
  let tmpCwd: string;
  let originalCwd: string;

  beforeEach(() => {
    resetConfig();
    mockFetch.mockReset();
    originalCwd = process.cwd();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
    process.chdir(tmpCwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    resetConfig();
  });

  /**
   * Stub every outbound fetch the doctor makes.
   *  - registry.npmjs.org    → returns { version }
   *  - /v2/team/credit-usage → returns credit usage payload + status
   *  - /v2/team/queue-status → returns queue payload + status
   */
  function stubFetch(opts: {
    latestVersion?: string;
    registryUnreachable?: boolean;
    creditsStatus?: number;
    credits?: { remainingCredits?: number; planCredits?: number };
    queueStatus?: number;
    queue?: {
      success?: boolean;
      activeJobsInQueue?: number;
      maxConcurrency?: number;
    };
    slowMs?: number;
  }): void {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('registry.npmjs.org')) {
        if (opts.registryUnreachable) throw new Error('ENOTFOUND');
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: opts.latestVersion ?? '1.0.0' }),
        };
      }
      if (url.includes('/v2/team/credit-usage')) {
        if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
        const status = opts.creditsStatus ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => ({ data: opts.credits ?? {} }),
        };
      }
      if (url.includes('/v2/team/queue-status')) {
        const status = opts.queueStatus ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => ({
            success: true,
            activeJobsInQueue: 0,
            maxConcurrency: 10,
            ...opts.queue,
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  function checkByName(checks: any[], name: string) {
    const c = checks.find((x) => x.name === name);
    if (!c) throw new Error(`Missing check: ${name}`);
    return c;
  }

  it('fails the API Key check when no key is configured', async () => {
    stubFetch({});
    const { checks } = await runChecks({});
    expect(checkByName(checks, 'API Key').status).toBe('fail');
    // Without a key we don't ping the API, so concurrency comes back as fail
    expect(checkByName(checks, 'Concurrency').status).toBe('fail');
  });

  it('passes the happy path with current version and full credits', async () => {
    initializeConfig({
      apiKey: 'fc-abc123def456',
      apiUrl: 'https://api.firecrawl.dev',
    });
    stubFetch({
      latestVersion: '0.0.1', // older than packageJson, so doctor sees pass
      credits: { remainingCredits: 9000, planCredits: 10000 },
      queue: { success: true, activeJobsInQueue: 1, maxConcurrency: 10 },
    });

    const { checks } = await runChecks({});

    expect(checkByName(checks, 'API Key').status).toBe('pass');
    expect(checkByName(checks, 'API Reachability').status).toBe('pass');
    expect(checkByName(checks, 'API Key Validity').status).toBe('pass');
    expect(checkByName(checks, 'Credits').status).toBe('pass');
    expect(checkByName(checks, 'Concurrency').status).toBe('pass');
  });

  it('labels API keys passed by flag as flag sourced', async () => {
    initializeConfig({
      apiKey: 'fc-stored',
      apiUrl: 'https://api.firecrawl.dev',
    });
    stubFetch({
      credits: { remainingCredits: 500, planCredits: 1000 },
    });

    const { checks } = await runChecks({ apiKey: 'fc-flag' });

    expect(checkByName(checks, 'API Key').message).toBe('fc-...flag (flag)');
  });

  it('warns on outdated CLI version', async () => {
    initializeConfig({
      apiKey: 'fc-test',
      apiUrl: 'https://api.firecrawl.dev',
    });
    stubFetch({
      latestVersion: '99.99.99',
      credits: { remainingCredits: 100, planCredits: 1000 },
    });
    const { checks } = await runChecks({});
    expect(checkByName(checks, 'CLI Version').status).toBe('warn');
  });

  it('fails API Key Validity on 401', async () => {
    initializeConfig({ apiKey: 'fc-bad', apiUrl: 'https://api.firecrawl.dev' });
    stubFetch({ creditsStatus: 401 });
    const { checks } = await runChecks({});
    expect(checkByName(checks, 'API Key Validity').status).toBe('fail');
  });

  it('warns when credits are below 10% of plan', async () => {
    initializeConfig({
      apiKey: 'fc-test',
      apiUrl: 'https://api.firecrawl.dev',
    });
    stubFetch({
      credits: { remainingCredits: 50, planCredits: 1000 },
    });
    const { checks } = await runChecks({});
    expect(checkByName(checks, 'Credits').status).toBe('warn');
  });

  it('does not render impossible credit percentages above 100%', async () => {
    initializeConfig({
      apiKey: 'fc-test',
      apiUrl: 'https://api.firecrawl.dev',
    });
    stubFetch({
      credits: { remainingCredits: 5000, planCredits: 1000 },
    });

    const { checks } = await runChecks({});

    expect(checkByName(checks, 'Credits')).toMatchObject({
      status: 'pass',
      message: '5,000 / 1,000 (above plan)',
    });
  });

  it('fails when credits hit zero', async () => {
    initializeConfig({
      apiKey: 'fc-test',
      apiUrl: 'https://api.firecrawl.dev',
    });
    stubFetch({
      credits: { remainingCredits: 0, planCredits: 1000 },
    });
    const { checks } = await runChecks({});
    expect(checkByName(checks, 'Credits').status).toBe('fail');
  });

  it('warns concurrency when active >= max', async () => {
    initializeConfig({
      apiKey: 'fc-test',
      apiUrl: 'https://api.firecrawl.dev',
    });
    stubFetch({
      credits: { remainingCredits: 500, planCredits: 1000 },
      queue: { success: true, activeJobsInQueue: 10, maxConcurrency: 10 },
    });
    const { checks } = await runChecks({});
    expect(checkByName(checks, 'Concurrency').status).toBe('warn');
  });

  it('warns when .firecrawl/ exists but .gitignore is missing', async () => {
    initializeConfig({
      apiKey: 'fc-test',
      apiUrl: 'https://api.firecrawl.dev',
    });
    fs.mkdirSync(path.join(tmpCwd, '.firecrawl'));
    stubFetch({ credits: { remainingCredits: 500, planCredits: 1000 } });
    const { checks } = await runChecks({});
    expect(checkByName(checks, '.gitignore').status).toBe('warn');
  });

  it('passes when .firecrawl/ exists and is gitignored', async () => {
    initializeConfig({
      apiKey: 'fc-test',
      apiUrl: 'https://api.firecrawl.dev',
    });
    fs.mkdirSync(path.join(tmpCwd, '.firecrawl'));
    fs.writeFileSync(path.join(tmpCwd, '.gitignore'), '.firecrawl/\n');
    stubFetch({ credits: { remainingCredits: 500, planCredits: 1000 } });
    const { checks } = await runChecks({});
    expect(checkByName(checks, '.gitignore').status).toBe('pass');
  });

  it('warns when .env key mismatches configured key', async () => {
    initializeConfig({
      apiKey: 'fc-stored',
      apiUrl: 'https://api.firecrawl.dev',
    });
    fs.writeFileSync(
      path.join(tmpCwd, '.env'),
      'FIRECRAWL_API_KEY=fc-different\n'
    );
    stubFetch({ credits: { remainingCredits: 500, planCredits: 1000 } });
    const { checks } = await runChecks({});
    expect(checkByName(checks, 'Local .env').status).toBe('warn');
  });

  it('warns on custom (non-default) API URL', async () => {
    initializeConfig({ apiKey: 'fc-test', apiUrl: 'http://localhost:3002' });
    stubFetch({ credits: { remainingCredits: 500, planCredits: 1000 } });
    const { checks } = await runChecks({});
    expect(checkByName(checks, 'API Reachability').status).toBe('warn');
  });

  it('does not warn on the default API URL with a trailing slash', async () => {
    initializeConfig({
      apiKey: 'fc-test',
      apiUrl: 'https://api.firecrawl.dev/',
    });
    stubFetch({ credits: { remainingCredits: 500, planCredits: 1000 } });

    const { checks } = await runChecks({});

    expect(checkByName(checks, 'API Reachability').status).toBe('pass');
  });

  it('returns plain messages without ANSI escapes for JSON output', async () => {
    initializeConfig({
      apiKey: 'fc-test',
      apiUrl: 'https://api.firecrawl.dev',
    });
    stubFetch({
      latestVersion: '99.99.99',
      credits: { remainingCredits: 500, planCredits: 1000 },
    });

    const { checks } = await runChecks({});

    expect(JSON.stringify({ checks })).not.toMatch(/\u001b\[/);
    expect(checkByName(checks, 'CLI Version').message).toContain(
      '(v99.99.99 available)'
    );
  });
});

describe('runSupportAsk', () => {
  const jobId = '123e4567-e89b-12d3-a456-426614174000';

  beforeEach(() => {
    resetConfig();
    mockFetch.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetConfig();
  });

  it('posts question and jobId to the support Ask endpoint', async () => {
    initializeConfig({
      apiKey: 'fc-test',
      apiUrl: 'https://api.firecrawl.dev',
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        answer: 'Try increasing waitFor.',
        fixParameters: { waitFor: 5000 },
      }),
    });

    const exitCode = await runSupportAsk({
      jobId,
      query: 'why did this scrape return empty markdown?',
    });

    expect(exitCode).toBe(0);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.firecrawl.dev/v2/support/ask',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer fc-test',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          question: 'why did this scrape return empty markdown?',
          jobId,
        }),
      })
    );
  });

  it('does not call support Ask without an API key', async () => {
    const exitCode = await runSupportAsk({ jobId });

    expect(exitCode).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
