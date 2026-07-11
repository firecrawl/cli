import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  handleMakeDefaultCommand,
  handleSetupCommand,
  installHermesMcp,
  installOpenClawMcp,
  installSkillsForAgent,
} from '../../commands/setup';
import { ALL_SKILL_REPOS } from '../../commands/skills-install';
import { configureWebDefaults } from '../../utils/web-defaults';
import { getApiKey } from '../../utils/config';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../utils/web-defaults', () => ({
  configureWebDefaults: vi.fn(async () => []),
}));

vi.mock('../../utils/config', () => ({
  getApiKey: vi.fn(() => 'fc-test-key'),
}));

describe('handleSetupCommand', () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getApiKey).mockReturnValue('fc-test-key');
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    vi.restoreAllMocks();
  });

  it('installs core and build skills globally across all detected agents by default', async () => {
    await handleSetupCommand('skills', {});

    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/cli --full-depth --global --all',
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/skills --full-depth --global --all',
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('installs core and build skills globally for a specific agent without using --all', async () => {
    await handleSetupCommand('skills', { agent: 'cursor' });

    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/cli --full-depth --global --agent cursor',
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/skills --full-depth --global --agent cursor',
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('installs workflow skills as a separate setup option', async () => {
    await handleSetupCommand('workflows', {});

    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/firecrawl-workflows --full-depth --global --all',
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('installs all skill repos for Codex non-interactively', async () => {
    await installSkillsForAgent(
      'codex',
      { global: true, yes: true },
      ALL_SKILL_REPOS
    );

    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/cli --full-depth --global --yes --agent codex',
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/skills --full-depth --global --yes --agent codex',
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/firecrawl-workflows --full-depth --global --yes --agent codex',
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('configures Firecrawl as the default web provider via make default', async () => {
    await handleMakeDefaultCommand({ yes: true });

    expect(configureWebDefaults).toHaveBeenCalledWith({
      undo: false,
      agents: undefined,
    });
  });

  it('installs the default setup bundle with --yes', async () => {
    await handleSetupCommand(undefined, { yes: true });

    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/cli --full-depth --global --all --yes',
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/skills --full-depth --global --all --yes',
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(execSync).toHaveBeenCalledWith(
      'npx -y add-mcp "https://mcp.firecrawl.dev/fc-test-key/v2/mcp" --name firecrawl --transport http --global --yes',
      expect.objectContaining({
        stdio: 'inherit',
      })
    );
  });

  it('requires a subcommand for bare setup in non-interactive mode', async () => {
    const originalIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    });

    try {
      await expect(handleSetupCommand()).rejects.toThrow(
        'Setup subcommand is required in non-interactive mode'
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: originalIsTty,
      });
    }
  });

  it('configures Firecrawl as the default web provider', async () => {
    await handleSetupCommand('defaults', { yes: true });

    expect(configureWebDefaults).toHaveBeenCalledWith({
      undo: false,
      agents: undefined,
    });
  });

  it('undoes default web provider config', async () => {
    await handleSetupCommand('defaults', { undo: true, yes: true });

    expect(configureWebDefaults).toHaveBeenCalledWith({
      undo: true,
      agents: undefined,
    });
  });

  it('limits defaults config to a single agent', async () => {
    await handleSetupCommand('defaults', { undo: true, agent: 'codex' });

    expect(configureWebDefaults).toHaveBeenCalledWith({
      undo: true,
      agents: ['Codex'],
    });
  });

  it('installs MCP with the hosted Firecrawl URL when credentials exist', async () => {
    await handleSetupCommand('mcp', {
      agent: 'claude-code',
      global: true,
      yes: true,
    });

    expect(execSync).toHaveBeenCalledWith(
      'npx -y add-mcp "https://mcp.firecrawl.dev/fc-test-key/v2/mcp" --name firecrawl --transport http --global --agent claude-code --yes',
      expect.objectContaining({
        stdio: 'inherit',
      })
    );
  });

  it('normalizes launch aliases when reinstalling MCP after auth changes', async () => {
    await handleSetupCommand('mcp', {
      agent: 'codex-app',
      global: true,
      yes: true,
    });

    expect(execSync).toHaveBeenCalledWith(
      'npx -y add-mcp "https://mcp.firecrawl.dev/fc-test-key/v2/mcp" --name firecrawl --transport http --global --agent codex --yes',
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('installs MCP with the keyless hosted Firecrawl URL without credentials', async () => {
    vi.mocked(getApiKey).mockReturnValue(undefined);

    await handleSetupCommand('mcp', {
      agent: 'claude-code',
      global: true,
      yes: true,
    });

    expect(execSync).toHaveBeenCalledWith(
      'npx -y add-mcp "https://mcp.firecrawl.dev/v2/mcp" --name firecrawl --transport http --global --agent claude-code --yes',
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('writes Hermes MCP config with Firecrawl credentials', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-hermes-test-'));
    process.env.HOME = home;

    try {
      await installHermesMcp();

      const config = readFileSync(
        path.join(home, '.hermes', 'config.yaml'),
        'utf-8'
      );
      expect(config).toContain('mcp_servers:');
      expect(config).toContain('firecrawl:');
      expect(config).toContain(
        'url: https://mcp.firecrawl.dev/fc-test-key/v2/mcp'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('configures OpenClaw MCP with its native CLI command', async () => {
    await installOpenClawMcp();

    expect(execSync).toHaveBeenCalledWith(
      'openclaw mcp set firecrawl "{\\"url\\":\\"https://mcp.firecrawl.dev/fc-test-key/v2/mcp\\",\\"transport\\":\\"streamable-http\\"}"',
      expect.objectContaining({
        stdio: 'inherit',
      })
    );
  });

  it('reinstalls MCP for all launch integrations with --agent all', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-all-mcp-test-'));
    process.env.HOME = home;

    try {
      await handleSetupCommand('mcp', {
        agent: 'all',
        global: true,
        yes: true,
      });

      expect(execSync).toHaveBeenCalledWith(
        'npx -y add-mcp "https://mcp.firecrawl.dev/fc-test-key/v2/mcp" --name firecrawl --transport http --global --all --yes',
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(
        readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf-8')
      ).toContain('url: https://mcp.firecrawl.dev/fc-test-key/v2/mcp');
      expect(execSync).toHaveBeenCalledWith(
        'openclaw mcp set firecrawl "{\\"url\\":\\"https://mcp.firecrawl.dev/fc-test-key/v2/mcp\\",\\"transport\\":\\"streamable-http\\"}"',
        expect.objectContaining({ stdio: 'inherit' })
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('strips inherited npm_* env vars before nested npx calls', async () => {
    // Reproduces the bug where running this CLI under `npx -y firecrawl-cli@VERSION`
    // leaks npm_command/npm_lifecycle_event/npm_execpath into nested
    // `npx -y skills add` calls and causes the second iteration to silently
    // not run. Without stripping, only the first repo gets installed.
    const restore = {
      npm_command: process.env.npm_command,
      npm_lifecycle_event: process.env.npm_lifecycle_event,
      npm_execpath: process.env.npm_execpath,
      INIT_CWD: process.env.INIT_CWD,
    };
    process.env.npm_command = 'exec';
    process.env.npm_lifecycle_event = 'npx';
    process.env.npm_execpath = '/fake/npm-cli.js';
    process.env.INIT_CWD = '/fake/init-cwd';

    try {
      await handleSetupCommand('skills', {});

      const allCalls = (
        execSync as unknown as {
          mock: { calls: [string, { env?: NodeJS.ProcessEnv }][] };
        }
      ).mock.calls;
      const installCalls = allCalls.filter(([cmd]) =>
        cmd.includes('skills add')
      );
      expect(installCalls.length).toBe(2);
      for (const [, opts] of installCalls) {
        expect(opts.env).toBeDefined();
        expect(opts.env!.npm_command).toBeUndefined();
        expect(opts.env!.npm_lifecycle_event).toBeUndefined();
        expect(opts.env!.npm_execpath).toBeUndefined();
        expect(opts.env!.INIT_CWD).toBeUndefined();
      }
    } finally {
      for (const [k, v] of Object.entries(restore)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
