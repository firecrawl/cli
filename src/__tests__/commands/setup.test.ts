import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
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
  execFileSync: vi.fn(),
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
  let originalApiKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getApiKey).mockReturnValue('fc-test-key');
    originalHome = process.env.HOME;
    originalApiKey = process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = originalApiKey;
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
    expect(execFileSync).toHaveBeenCalledWith(
      'npx',
      [
        '-y',
        'add-mcp@1.14.0',
        'https://mcp.firecrawl.dev/v2/mcp',
        '--name',
        'firecrawl',
        '--transport',
        'http',
        '--header',
        'Authorization: Bearer fc-test-key',
        '--global',
        '--yes',
      ],
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

  it('installs MCP with credentials in an Authorization header', async () => {
    await handleSetupCommand('mcp', {
      agent: 'claude-code',
      global: true,
      yes: true,
    });

    expect(execFileSync).toHaveBeenCalledWith(
      'npx',
      [
        '-y',
        'add-mcp@1.14.0',
        'https://mcp.firecrawl.dev/v2/mcp',
        '--name',
        'firecrawl',
        '--transport',
        'http',
        '--header',
        'Authorization: Bearer fc-test-key',
        '--global',
        '--agent',
        'claude-code',
        '--yes',
      ],
      expect.objectContaining({
        stdio: 'inherit',
      })
    );
  });

  it('writes project router state only after MCP setup succeeds', async () => {
    const project = mkdtempSync(
      path.join(os.tmpdir(), 'firecrawl-setup-router-')
    );
    let cardExistedDuringMcpSetup = true;
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      cardExistedDuringMcpSetup = existsSync(path.join(project, 'AGENTS.md'));
      return '' as never;
    });

    try {
      await handleSetupCommand('mcp', {
        agent: 'codex',
        project,
        routerCard: true,
        yes: true,
      });

      expect(cardExistedDuringMcpSetup).toBe(false);
      expect(readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toContain(
        'firecrawl-router-card:start'
      );
      expect(execFileSync).toHaveBeenCalledWith(
        'npx',
        expect.arrayContaining(['add-mcp@1.14.0', '--agent', 'codex']),
        expect.objectContaining({ cwd: project, stdio: 'inherit' })
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not write project router state when MCP setup fails', async () => {
    const project = mkdtempSync(
      path.join(os.tmpdir(), 'firecrawl-setup-router-')
    );
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('setup failed');
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit 1');
    }) as never);

    try {
      await expect(
        handleSetupCommand('mcp', {
          agent: 'codex',
          project,
          routerCard: true,
          yes: true,
        })
      ).rejects.toThrow('exit 1');
      expect(exit).toHaveBeenCalledWith(1);
      expect(existsSync(path.join(project, 'AGENTS.md'))).toBe(false);
      expect(existsSync(path.join(project, '.firecrawl'))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('keeps ordinary and explicit default-off MCP setup router-neutral', async () => {
    const project = mkdtempSync(
      path.join(os.tmpdir(), 'firecrawl-setup-router-')
    );
    const card = path.join(project, 'AGENTS.md');
    const existing =
      'before\n\n<!-- firecrawl-router-card:start -->\nold\n<!-- firecrawl-router-card:end -->\n';
    writeFileSync(card, existing);

    try {
      await handleSetupCommand('mcp', {
        agent: 'codex',
        project,
        yes: true,
      });
      expect(readFileSync(card, 'utf8')).toBe(existing);

      await handleSetupCommand('mcp', {
        agent: 'codex',
        project,
        routerCard: false,
        yes: true,
      });
      expect(readFileSync(card, 'utf8')).toBe(existing);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('does not inspect malformed router state for explicit default-off setup', async () => {
    const project = mkdtempSync(
      path.join(os.tmpdir(), 'firecrawl-setup-router-')
    );
    const card = path.join(project, 'AGENTS.md');
    const malformed =
      'before\n<!-- firecrawl-router-card:start -->\nunterminated\n';
    writeFileSync(card, malformed);

    try {
      await handleSetupCommand('mcp', {
        agent: 'codex',
        project,
        routerCard: false,
        yes: true,
      });
      expect(execFileSync).toHaveBeenCalledOnce();
      expect(readFileSync(card, 'utf8')).toBe(malformed);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('removes only managed project router state without running MCP setup', async () => {
    const project = mkdtempSync(
      path.join(os.tmpdir(), 'firecrawl-setup-router-')
    );
    const card = path.join(project, 'AGENTS.md');
    writeFileSync(
      card,
      'before\n\n<!-- firecrawl-router-card:start -->\nold\n<!-- firecrawl-router-card:end -->\n'
    );

    try {
      await handleSetupCommand('mcp', {
        agent: 'codex',
        project,
        removeRouterCard: true,
      });

      expect(execFileSync).not.toHaveBeenCalled();
      expect(readFileSync(card, 'utf8')).toBe('before\n');
      expect(existsSync(path.join(project, '.firecrawl'))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('fails router actions closed before MCP side effects', async () => {
    const project = mkdtempSync(
      path.join(os.tmpdir(), 'firecrawl-setup-router-')
    );
    try {
      await expect(
        handleSetupCommand('mcp', {
          agent: 'codex',
          routerCard: true,
        })
      ).rejects.toThrow('--project');
      await expect(
        handleSetupCommand('mcp', {
          agent: 'cursor',
          project,
          routerCard: true,
        })
      ).rejects.toThrow('claude-code and --agent codex');
      await expect(
        handleSetupCommand('mcp', {
          agent: 'codex',
          project,
          routerCard: false,
          removeRouterCard: true,
        })
      ).rejects.toThrow('conflicts');
      expect(execFileSync).not.toHaveBeenCalled();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('normalizes launch aliases when reinstalling MCP after auth changes', async () => {
    await handleSetupCommand('mcp', {
      agent: 'codex-app',
      global: true,
      yes: true,
    });

    expect(execFileSync).toHaveBeenCalledWith(
      'npx',
      [
        '-y',
        'add-mcp@1.14.0',
        'https://mcp.firecrawl.dev/v2/mcp',
        '--name',
        'firecrawl',
        '--transport',
        'http',
        '--header',
        'Authorization: Bearer fc-test-key',
        '--global',
        '--agent',
        'codex',
        '--yes',
      ],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it.each([
    ['claude', 'claude-code'],
    ['vscode', 'vscode'],
    ['codex', 'codex'],
    ['opencode', 'opencode'],
    ['cursor', 'cursor'],
  ])(
    'uses header authentication for the %s setup path',
    async (agent, target) => {
      await handleSetupCommand('mcp', {
        agent,
        global: true,
        yes: true,
      });

      expect(execFileSync).toHaveBeenCalledWith(
        'npx',
        [
          '-y',
          'add-mcp@1.14.0',
          'https://mcp.firecrawl.dev/v2/mcp',
          '--name',
          'firecrawl',
          '--transport',
          'http',
          '--header',
          'Authorization: Bearer fc-test-key',
          '--global',
          '--agent',
          target,
          '--yes',
        ],
        expect.objectContaining({ stdio: 'inherit' })
      );
    }
  );

  it.each([
    ['cursor', 'Bearer ${env:FIRECRAWL_API_KEY}'],
    ['opencode', 'Bearer {env:FIRECRAWL_API_KEY}'],
  ])(
    'uses the %s environment reference when the API key came from the environment',
    async (agent, header) => {
      process.env.FIRECRAWL_API_KEY = 'fc-test-key';

      await handleSetupCommand('mcp', {
        agent,
        global: true,
        yes: true,
      });

      const args = vi.mocked(execFileSync).mock.calls[0]?.[1];
      expect(args).toContain(`Authorization: ${header}`);
      expect(args?.join(' ')).not.toContain('Bearer fc-test-key');
    }
  );

  it('uses Codex native environment-backed bearer configuration', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    await handleSetupCommand('mcp', {
      agent: 'codex',
      global: true,
      yes: true,
    });

    expect(execFileSync).toHaveBeenCalledWith(
      'codex',
      [
        'mcp',
        'add',
        'firecrawl',
        '--url',
        'https://mcp.firecrawl.dev/v2/mcp',
        '--bearer-token-env-var',
        'FIRECRAWL_API_KEY',
      ],
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(vi.mocked(execFileSync).mock.calls.flat(2).join(' ')).not.toContain(
      'fc-test-key'
    );
  });

  it('installs MCP with the keyless hosted Firecrawl URL without credentials', async () => {
    vi.mocked(getApiKey).mockReturnValue(undefined);

    await handleSetupCommand('mcp', {
      agent: 'claude-code',
      global: true,
      yes: true,
    });

    expect(execFileSync).toHaveBeenCalledWith(
      'npx',
      [
        '-y',
        'add-mcp@1.14.0',
        'https://mcp.firecrawl.dev/v2/mcp',
        '--name',
        'firecrawl',
        '--transport',
        'http',
        '--global',
        '--agent',
        'claude-code',
        '--yes',
      ],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('writes Hermes MCP config with Firecrawl credentials', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-hermes-test-'));
    process.env.HOME = home;
    const configPath = path.join(home, '.hermes', 'config.yaml');
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      'theme: dark\nmcp_servers:\n  existing:\n    url: https://example.com/mcp\n'
    );

    try {
      await installHermesMcp();

      const config = readFileSync(configPath, 'utf-8');
      expect(config).toContain('theme: dark');
      expect(config).toContain('existing:');
      expect(config).toContain('mcp_servers:');
      expect(config).toContain('firecrawl:');
      expect(config).toContain('url: https://mcp.firecrawl.dev/v2/mcp');
      expect(config).toContain('Authorization: Bearer fc-test-key');
      expect(config).not.toContain('/fc-test-key/');
      if (process.platform !== 'win32') {
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('configures OpenClaw MCP with its native CLI command', async () => {
    await installOpenClawMcp();

    expect(execFileSync).toHaveBeenCalledWith(
      'openclaw',
      [
        'mcp',
        'set',
        'firecrawl',
        '{"url":"https://mcp.firecrawl.dev/v2/mcp","headers":{"Authorization":"Bearer fc-test-key"},"transport":"streamable-http"}',
      ],
      expect.objectContaining({
        stdio: 'pipe',
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

      expect(execFileSync).toHaveBeenCalledWith(
        'npx',
        [
          '-y',
          'add-mcp@1.14.0',
          'https://mcp.firecrawl.dev/v2/mcp',
          '--name',
          'firecrawl',
          '--transport',
          'http',
          '--header',
          'Authorization: Bearer fc-test-key',
          '--global',
          '--all',
          '--yes',
        ],
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(
        readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf-8')
      ).toContain('Authorization: Bearer fc-test-key');
      expect(execFileSync).toHaveBeenCalledWith(
        'openclaw',
        [
          'mcp',
          'set',
          'firecrawl',
          '{"url":"https://mcp.firecrawl.dev/v2/mcp","headers":{"Authorization":"Bearer fc-test-key"},"transport":"streamable-http"}',
        ],
        expect.objectContaining({ stdio: 'pipe' })
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('never includes hosted MCP credentials in generated URLs or normal output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleSetupCommand('mcp', {
      agent: 'claude-code',
      global: true,
      yes: true,
    });

    const args = vi.mocked(execFileSync).mock.calls[0]?.[1];
    expect(args).toContain('https://mcp.firecrawl.dev/v2/mcp');
    expect(args?.join(' ')).not.toContain('mcp.firecrawl.dev/fc-test-key');
    expect(log.mock.calls.flat().join(' ')).not.toContain('fc-test-key');
  });

  it('does not print an OpenClaw command containing credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await installOpenClawMcp();

    expect(log.mock.calls.flat().join(' ')).not.toContain('fc-test-key');
  });

  it('passes hostile credential characters as inert argv without printing them', async () => {
    const hostileKey = 'fc-$(touch /tmp/firecrawl-pwned)`echo bad`"\n$HOME';
    vi.mocked(getApiKey).mockReturnValue(hostileKey);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await handleSetupCommand('mcp', {
      agent: 'claude-code',
      global: true,
      yes: true,
    });

    expect(execFileSync).toHaveBeenCalledWith(
      'npx',
      expect.arrayContaining([
        'https://mcp.firecrawl.dev/v2/mcp',
        `Authorization: Bearer ${hostileKey}`,
      ]),
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(execSync).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).not.toContain(hostileKey);
    expect(error.mock.calls.flat().join(' ')).not.toContain(hostileKey);
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
