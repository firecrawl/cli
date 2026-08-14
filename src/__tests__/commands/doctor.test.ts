/**
 * Tests for the doctor command. Covers:
 *  - version comparison utility
 *  - MCP-entry detection helper
 *  - runChecks() across pass/warn/fail scenarios
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { compareVersions } from '../../utils/npm-registry';
import { detectAgents, hasFirecrawlMcpEntry } from '../../utils/agents';
import { runChecks, runSupportAsk } from '../../commands/doctor';
import { initializeConfig, resetConfig } from '../../utils/config';
import { ALL_MCP_CLIENT_IDS, createMcpContext } from '../../utils/mcp-clients';
import { setupMcpClient } from '../../utils/mcp-install';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => {
      throw new Error('openclaw missing');
    }),
  };
});

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

  it('ignores a nested servers map that is not the agent MCP config', () => {
    expect(
      hasFirecrawlMcpEntry({
        'someExtension.config': { servers: { firecrawl: {} } },
      })
    ).toBe(false);
  });

  it('detects firecrawl under OpenCode top-level mcp', () => {
    expect(
      hasFirecrawlMcpEntry({
        mcp: {
          firecrawl: {
            type: 'remote',
            url: 'https://mcp.firecrawl.dev/v2/mcp',
          },
        },
      })
    ).toBe(true);
  });
});

describe('detectAgents', () => {
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;
  let originalClaudeConfigDir: string | undefined;
  let originalCodexHome: string | undefined;
  let originalHermesHome: string | undefined;
  let originalAppData: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-agents-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    originalCodexHome = process.env.CODEX_HOME;
    originalHermesHome = process.env.HERMES_HOME;
    originalAppData = process.env.APPDATA;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    delete process.env.HERMES_HOME;
    process.env.APPDATA = path.join(tmpHome, 'AppData', 'Roaming');
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('openclaw missing');
    });
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHermesHome;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  });

  it('reports OpenCode registered from a JSONC config', async () => {
    const dir = path.join(tmpHome, '.config', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      `{
  // remote Firecrawl
  "mcp": {
    "firecrawl": {
      "type": "remote",
      "url": "https://mcp.firecrawl.dev/v2/mcp",
      "enabled": true,
    },
  },
}
`
    );

    const opencode = (await detectAgents(tmpHome)).find(
      (agent) => agent.id === 'opencode'
    );
    expect(opencode?.installed).toBe(true);
    expect(opencode?.mcpRegistered).toBe(true);
  });

  it('reports Hermes registered after setup writes config.yaml', async () => {
    const dir = path.join(tmpHome, '.hermes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      'mcp_servers:\n  firecrawl:\n    url: https://mcp.firecrawl.dev/v2/mcp\n'
    );

    const hermes = (await detectAgents(tmpHome)).find(
      (agent) => agent.id === 'hermes'
    );
    expect(hermes?.installed).toBe(true);
    expect(hermes?.mcpRegistered).toBe(true);
  });

  it('still sees Firecrawl in JSONC after a recoverable parse error', async () => {
    const dir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'mcp.json'),
      `{
  "theme": "dark"
  "mcpServers": { "firecrawl": { "url": "https://mcp.firecrawl.dev/v2/mcp" } }
}
`
    );

    const cursor = (await detectAgents(tmpHome)).find(
      (agent) => agent.id === 'cursor'
    );
    expect(cursor?.installed).toBe(true);
    expect(cursor?.mcpRegistered).toBe(true);
  });

  it('does not treat an unreadable JSON config as registered', async () => {
    const dir = path.join(tmpHome, '.cursor');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mcp.json'), '{ oops');

    const cursor = (await detectAgents(tmpHome)).find(
      (agent) => agent.id === 'cursor'
    );
    expect(cursor?.mcpRegistered).toBe(false);
  });

  it('does not treat a YAML comment mentioning firecrawl as registration', async () => {
    const dir = path.join(tmpHome, '.hermes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      '# firecrawl:\nmcp_servers:\n  github:\n    command: npx\n'
    );

    const hermes = (await detectAgents(tmpHome)).find(
      (agent) => agent.id === 'hermes'
    );
    expect(hermes?.mcpRegistered).toBe(false);
  });

  it('detects OpenClaw from a runnable PATH binary without ~/.openclaw', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-openclaw-bin-'));
    const binary = path.join(
      bin,
      process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw'
    );
    fs.writeFileSync(binary, '');
    if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        name: 'firecrawl',
        url: 'https://mcp.firecrawl.dev/v2/mcp',
      })
    );

    try {
      const openclaw = (await detectAgents(tmpHome)).find(
        (agent) => agent.id === 'openclaw'
      );
      expect(openclaw?.installed).toBe(true);
      expect(openclaw?.mcpRegistered).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('reports OpenClaw registered via openclaw mcp show --json', async () => {
    fs.mkdirSync(path.join(tmpHome, '.openclaw'), { recursive: true });
    vi.mocked(execFileSync).mockReturnValue(
      JSON.stringify({
        name: 'firecrawl',
        url: 'https://mcp.firecrawl.dev/v2/mcp',
      })
    );

    const openclaw = (await detectAgents(tmpHome)).find(
      (agent) => agent.id === 'openclaw'
    );
    expect(openclaw?.installed).toBe(true);
    expect(openclaw?.mcpRegistered).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'openclaw',
      ['mcp', 'show', 'firecrawl', '--json'],
      expect.objectContaining({ encoding: 'utf8' })
    );
  });

  it('does not treat an OpenClaw config file as registration', async () => {
    const dir = path.join(tmpHome, '.openclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'openclaw.json'),
      JSON.stringify({
        mcp: {
          servers: {
            firecrawl: {
              url: 'https://mcp.firecrawl.dev/v2/mcp',
            },
          },
        },
      })
    );

    const openclaw = (await detectAgents(tmpHome)).find(
      (agent) => agent.id === 'openclaw'
    );
    expect(openclaw?.installed).toBe(true);
    expect(openclaw?.mcpRegistered).toBe(false);
  });

  it('follows CLAUDE_CONFIG_DIR for Claude Code detection', async () => {
    const override = path.join(tmpHome, 'custom-claude');
    fs.mkdirSync(override, { recursive: true });
    fs.writeFileSync(
      path.join(override, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          firecrawl: { type: 'http', url: 'https://mcp.firecrawl.dev/v2/mcp' },
        },
      })
    );
    process.env.CLAUDE_CONFIG_DIR = override;

    const claude = (await detectAgents(tmpHome)).find(
      (agent) => agent.id === 'claude-code'
    );
    expect(claude?.installed).toBe(true);
    expect(claude?.mcpRegistered).toBe(true);
  });

  it('follows CODEX_HOME for Codex detection and registration', async () => {
    const override = path.join(tmpHome, 'custom-codex');
    fs.mkdirSync(override, { recursive: true });
    fs.writeFileSync(
      path.join(override, 'config.toml'),
      '[mcp_servers."firecrawl"]\nurl = "https://mcp.firecrawl.dev/v2/mcp"\n'
    );
    process.env.CODEX_HOME = override;

    const codex = (await detectAgents(tmpHome)).find(
      (agent) => agent.id === 'codex'
    );
    expect(codex?.installed).toBe(true);
    expect(codex?.mcpRegistered).toBe(true);
    expect(codex?.configPaths[0]).toBe(path.join(override, 'config.toml'));
  });

  it('follows HERMES_HOME for Hermes detection and registration', async () => {
    const override = path.join(tmpHome, 'custom-hermes');
    fs.mkdirSync(override, { recursive: true });
    fs.writeFileSync(
      path.join(override, 'config.yaml'),
      'mcp_servers:\n  firecrawl:\n    url: https://mcp.firecrawl.dev/v2/mcp\n'
    );
    process.env.HERMES_HOME = override;

    const hermes = (await detectAgents(tmpHome)).find(
      (agent) => agent.id === 'hermes'
    );
    expect(hermes?.installed).toBe(true);
    expect(hermes?.mcpRegistered).toBe(true);
    expect(hermes?.configPaths[0]).toBe(path.join(override, 'config.yaml'));
  });

  it('sees every setup client as registered immediately after setup', async () => {
    const ctx = createMcpContext({
      home: tmpHome,
      cwd: tmpHome,
      env: process.env,
      auth: 'keyless',
    });

    for (const id of ALL_MCP_CLIENT_IDS) {
      const result = await setupMcpClient(id, { rules: false, ctx });
      expect(result.mcpStatus, id).toBe('configured');
    }

    const agents = await detectAgents(tmpHome);
    const doctorIds = [
      'cursor',
      'claude-code',
      'vscode',
      'codex',
      'opencode',
      'hermes',
    ] as const;
    for (const id of doctorIds) {
      const agent = agents.find((entry) => entry.id === id);
      expect(agent?.installed, id).toBe(true);
      expect(agent?.mcpRegistered, id).toBe(true);
    }
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
