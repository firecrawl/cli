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
  installMcp,
  installHermesMcp,
  installOpenClawMcp,
  installSkillsForAgent,
} from '../../commands/setup';
import {
  ALL_SKILL_REPOS,
  BUILD_SKILLS,
  CLI_SKILLS,
  WORKFLOW_SKILLS,
} from '../../commands/skills-install';

const cliSkillFlags = `--skill ${CLI_SKILLS.join(' ')}`;
const buildSkillFlags = `--skill ${BUILD_SKILLS.join(' ')}`;
const workflowSkillFlags = `--skill ${WORKFLOW_SKILLS.join(' ')}`;
import { configureWebDefaults } from '../../utils/web-defaults';
import { getApiKey } from '../../utils/config';
import { browserLogin, isAuthenticated } from '../../utils/auth';
import { saveCredentials } from '../../utils/credentials';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('../../utils/web-defaults', () => ({
  configureWebDefaults: vi.fn(async () => []),
}));

vi.mock('../../utils/config', () => ({
  getApiKey: vi.fn(() => 'fc-test-key'),
  updateConfig: vi.fn(),
}));

vi.mock('../../utils/auth', () => ({
  isAuthenticated: vi.fn(() => true),
  browserLogin: vi.fn(async () => ({
    apiKey: 'fc-browser-key',
    apiUrl: 'https://api.firecrawl.dev',
  })),
}));

vi.mock('../../utils/credentials', () => ({
  saveCredentials: vi.fn(),
}));

describe('handleSetupCommand', () => {
  let originalHome: string | undefined;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getApiKey).mockReturnValue('fc-test-key');
    vi.mocked(isAuthenticated).mockReturnValue(true);
    vi.mocked(browserLogin).mockResolvedValue({
      apiKey: 'fc-browser-key',
      apiUrl: 'https://api.firecrawl.dev',
    });
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

  it('installs the CLI skills from the catalog globally across all detected agents by default', async () => {
    await handleSetupCommand('skills', {});

    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills add firecrawl/skills --full-depth --global --yes ${cliSkillFlags}`,
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('installs the CLI skills globally for a specific agent without using --all', async () => {
    await handleSetupCommand('skills', { agent: 'cursor' });

    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills add firecrawl/skills --full-depth --global --yes --agent cursor ${cliSkillFlags}`,
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('treats "core" as the canonical name for the CLI skill set', async () => {
    await handleSetupCommand('core', {});

    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills add firecrawl/skills --full-depth --global --yes ${cliSkillFlags}`,
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('installs the build skills from the catalog as their own group', async () => {
    await handleSetupCommand('build', {});

    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills add firecrawl/skills --full-depth --global --yes ${buildSkillFlags}`,
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('does not offer auth when already authenticated', async () => {
    await handleSetupCommand('core', {});

    expect(browserLogin).not.toHaveBeenCalled();
  });

  it('prints a hint instead of logging in when unauthenticated and non-interactive', async () => {
    vi.mocked(isAuthenticated).mockReturnValue(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleSetupCommand('core', { yes: true });

    expect(browserLogin).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain(
      'No Firecrawl API key found'
    );
  });

  it('runs the browser login and persists credentials with --browser when unauthenticated', async () => {
    vi.mocked(isAuthenticated).mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleSetupCommand('core', { yes: true, browser: true });

    expect(browserLogin).toHaveBeenCalled();
    expect(saveCredentials).toHaveBeenCalledWith({
      apiKey: 'fc-browser-key',
      apiUrl: 'https://api.firecrawl.dev',
    });
  });

  it('installs a single catalog skill by exact name', async () => {
    await handleSetupCommand('firecrawl-developer-index', {});

    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/skills --full-depth --global --yes --skill firecrawl-developer-index',
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('resolves bare skill names by adding the firecrawl- prefix', async () => {
    await handleSetupCommand('developer-index', {});

    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/skills --full-depth --global --yes --skill firecrawl-developer-index',
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('prefers the build group over the firecrawl-build skill for bare "build"', async () => {
    await handleSetupCommand('build', {});

    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills add firecrawl/skills --full-depth --global --yes ${buildSkillFlags}`,
      expect.objectContaining({ stdio: 'inherit' })
    );

    vi.mocked(execSync).mockClear();
    await handleSetupCommand('firecrawl-build', {});

    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/skills --full-depth --global --yes --skill firecrawl-build',
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('installs workflow skills from the catalog as a separate setup option', async () => {
    await handleSetupCommand('workflows', {});

    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills add firecrawl/skills --full-depth --global --yes ${workflowSkillFlags}`,
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
    vi.mocked(getApiKey).mockReturnValue(undefined);

    await handleSetupCommand(undefined, { yes: true });

    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills add firecrawl/skills --full-depth --global --yes ${cliSkillFlags}`,
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
        '--global',
        '--yes',
      ],
      expect.objectContaining({ stdio: 'inherit' })
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

  it('fails closed before spawning when only a stored API key is available', async () => {
    await expect(
      handleSetupCommand('mcp', {
        agent: 'claude-code',
        global: true,
        yes: true,
      })
    ).rejects.toThrow('Export FIRECRAWL_API_KEY');
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('can explicitly install keyless MCP without exposing a stored API key', async () => {
    await installMcp({
      agent: 'claude-code',
      global: true,
      yes: true,
      keyless: true,
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
    expect(vi.mocked(execFileSync).mock.calls.flat().join(' ')).not.toContain(
      'fc-test-key'
    );
  });
  it('accepts a launch-scoped environment while keeping the stored key out of MCP config and argv', async () => {
    await installMcp(
      {
        agent: 'claude-code',
        global: true,
        yes: true,
      },
      { ...process.env, FIRECRAWL_API_KEY: 'fc-test-key' }
    );

    const args = vi.mocked(execFileSync).mock.calls[0]?.[1];
    expect(args).toContain('Authorization: Bearer ${FIRECRAWL_API_KEY}');
    expect(args?.join(' ')).not.toContain('fc-test-key');
    const subprocessEnv = vi.mocked(execFileSync).mock.calls[0]?.[2]?.env;
    expect(subprocessEnv?.FIRECRAWL_API_KEY).toBeUndefined();
  });
  it('normalizes launch aliases for environment-backed MCP setup', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    await handleSetupCommand('mcp', {
      agent: 'codex-app',
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
  });
  it.each([
    ['claude-code', 'Bearer ${FIRECRAWL_API_KEY}'],
    ['vscode', 'Bearer ${env:FIRECRAWL_API_KEY}'],
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

  it('rejects a stored key before writing Hermes MCP config', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-hermes-test-'));
    process.env.HOME = home;
    const configPath = path.join(home, '.hermes', 'config.yaml');
    mkdirSync(path.dirname(configPath), { recursive: true });
    const originalConfig =
      'theme: dark\nmcp_servers:\n  existing:\n    url: https://example.com/mcp\n';
    writeFileSync(configPath, originalConfig, { mode: 0o600 });

    try {
      await expect(
        handleSetupCommand('mcp', {
          agent: 'hermes',
          global: true,
          yes: true,
        })
      ).rejects.toThrow('Export FIRECRAWL_API_KEY');

      const config = readFileSync(configPath, 'utf-8');
      expect(config).toBe(originalConfig);
      expect(config).toContain('theme: dark');
      expect(config).toContain('existing:');
      expect(config).toContain('mcp_servers:');
      expect(config).not.toContain('firecrawl:');
      expect(config).not.toContain('fc-test-key');
      expect(execFileSync).not.toHaveBeenCalled();
      if (process.platform !== 'win32') {
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps an environment-backed key indirect in Hermes config', async () => {
    const home = mkdtempSync(
      path.join(os.tmpdir(), 'firecrawl-hermes-env-test-')
    );
    process.env.HOME = home;
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    try {
      await installHermesMcp();

      const config = readFileSync(
        path.join(home, '.hermes', 'config.yaml'),
        'utf-8'
      );
      expect(config).toContain('Authorization: Bearer ${FIRECRAWL_API_KEY}');
      expect(config).not.toContain('Bearer fc-test-key');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('honors explicit keyless setup for Hermes even when a key is stored', async () => {
    const home = mkdtempSync(
      path.join(os.tmpdir(), 'firecrawl-hermes-keyless-test-')
    );
    process.env.HOME = home;

    try {
      await installMcp({ agent: 'hermes', keyless: true });

      const config = readFileSync(
        path.join(home, '.hermes', 'config.yaml'),
        'utf-8'
      );
      expect(config).toContain('https://mcp.firecrawl.dev/v2/mcp');
      expect(config).not.toContain('Authorization');
      expect(config).not.toContain('fc-test-key');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a stored key before invoking the OpenClaw CLI', async () => {
    await expect(installOpenClawMcp()).rejects.toThrow(
      'Export FIRECRAWL_API_KEY'
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('uses OpenClaw environment expansion instead of persisting an env-backed key', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    await installOpenClawMcp();

    const config = vi.mocked(execFileSync).mock.calls[0]?.[1]?.[3] as string;
    expect(config).toContain('Bearer ${FIRECRAWL_API_KEY}');
    expect(config).not.toContain('Bearer fc-test-key');
  });

  it('honors explicit keyless setup for OpenClaw even when a key is stored', async () => {
    await installMcp({ agent: 'openclaw', keyless: true });

    const config = vi.mocked(execFileSync).mock.calls[0]?.[1]?.[3] as string;
    expect(config).toContain('https://mcp.firecrawl.dev/v2/mcp');
    expect(config).not.toContain('Authorization');
    expect(config).not.toContain('fc-test-key');
  });

  it('surfaces a sanitized OpenClaw setup failure', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error('spawn failed with Authorization: Bearer fc-test-key');
    });

    await expect(installOpenClawMcp()).rejects.toThrow(
      'Failed to configure Firecrawl MCP for OpenClaw. Verify that OpenClaw is installed and available on PATH.'
    );
  });

  it('rejects stored credentials before configuring any launch integration', async () => {
    await expect(
      handleSetupCommand('mcp', {
        agent: 'all',
        global: true,
        yes: true,
      })
    ).rejects.toThrow('Export FIRECRAWL_API_KEY');
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('uses each client native environment binding with --agent all', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-all-env-test-'));
    process.env.HOME = home;
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    try {
      await handleSetupCommand('mcp', {
        agent: 'all',
        global: true,
        yes: true,
      });

      const calls = vi.mocked(execFileSync).mock.calls;
      const serialized = calls.map((call) => (call[1] as string[]).join(' '));
      expect(serialized).toEqual(
        expect.arrayContaining([
          expect.stringContaining('claude-code --yes'),
          expect.stringContaining(
            'Authorization: Bearer ${env:FIRECRAWL_API_KEY}'
          ),
          expect.stringContaining('--bearer-token-env-var FIRECRAWL_API_KEY'),
          expect.stringContaining(
            'Authorization: Bearer {env:FIRECRAWL_API_KEY}'
          ),
          expect.stringContaining('Authorization: Bearer ${FIRECRAWL_API_KEY}'),
        ])
      );
      expect(calls.flat(2).join(' ')).not.toContain('Bearer fc-test-key');
      expect(
        readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf-8')
      ).toContain('Authorization: Bearer ${FIRECRAWL_API_KEY}');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects authenticated --agent all project setup before changing any client', async () => {
    const home = mkdtempSync(
      path.join(os.tmpdir(), 'firecrawl-all-project-preflight-')
    );
    process.env.HOME = home;
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    try {
      await expect(
        handleSetupCommand('mcp', {
          agent: 'all',
          project: true,
          yes: true,
        })
      ).rejects.toThrow(
        'Authenticated --agent all setup does not support --project'
      );

      expect(execFileSync).not.toHaveBeenCalled();
      expect(execSync).not.toHaveBeenCalled();
      expect(existsSync(path.join(home, '.hermes', 'config.yaml'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps keyless --agent all project setup available', async () => {
    const home = mkdtempSync(
      path.join(os.tmpdir(), 'firecrawl-all-project-keyless-')
    );
    process.env.HOME = home;
    vi.mocked(getApiKey).mockReturnValue(undefined);

    try {
      await handleSetupCommand('mcp', {
        agent: 'all',
        project: true,
        yes: true,
      });

      const addMcpCalls = vi
        .mocked(execFileSync)
        .mock.calls.filter(([, args]) =>
          (args as string[])?.includes('add-mcp@1.14.0')
        );
      expect(addMcpCalls).toHaveLength(5);
      expect(addMcpCalls.flat(2)).not.toContain('--global');
      expect(
        readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf-8')
      ).toContain('https://mcp.firecrawl.dev/v2/mcp');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('requires a client selection for no-agent environment-backed setup', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    await expect(
      handleSetupCommand('mcp', { global: true, yes: true })
    ).rejects.toThrow('requires --agent');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('rejects an environment-backed key for an unknown client instead of persisting it', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    await expect(
      handleSetupCommand('mcp', {
        agent: 'future-client',
        global: true,
        yes: true,
      })
    ).rejects.toThrow('does not have a verified environment-variable syntax');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('rejects a stored key for an unknown client before spawning', async () => {
    await expect(
      handleSetupCommand('mcp', {
        agent: 'future-client',
        global: true,
        yes: true,
      })
    ).rejects.toThrow('Export FIRECRAWL_API_KEY');
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('never includes environment-backed credentials in generated URLs or normal output', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleSetupCommand('mcp', {
      agent: 'claude-code',
      global: true,
      yes: true,
    });

    const args = vi.mocked(execFileSync).mock.calls[0]?.[1];
    expect(args).toContain('https://mcp.firecrawl.dev/v2/mcp');
    expect(args?.join(' ')).not.toContain('fc-test-key');
    expect(log.mock.calls.flat().join(' ')).not.toContain('fc-test-key');
  });
  it('never places a stored API key in subprocess argv', async () => {
    await expect(
      handleSetupCommand('mcp', {
        agent: 'claude-code',
        global: true,
        yes: true,
      })
    ).rejects.toThrow('Export FIRECRAWL_API_KEY');
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('does not print a stored OpenClaw credential when setup is rejected', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(installOpenClawMcp()).rejects.toThrow(
      'Export FIRECRAWL_API_KEY'
    );

    expect(log.mock.calls.flat().join(' ')).not.toContain('fc-test-key');
  });
  it('rejects stored credentials containing hostile characters without spawning or printing them', async () => {
    const hostileKey = 'fc-$(touch /tmp/firecrawl-pwned)`echo bad`"\\n$HOME';
    vi.mocked(getApiKey).mockReturnValue(hostileKey);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      handleSetupCommand('mcp', {
        agent: 'claude-code',
        global: true,
        yes: true,
      })
    ).rejects.toThrow('Export FIRECRAWL_API_KEY');

    expect(execFileSync).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).not.toContain(hostileKey);
    expect(error.mock.calls.flat().join(' ')).not.toContain(hostileKey);
  });
  // --- Scope: project and global are mutually exclusive ---

  it('rejects conflicting MCP scope flags', async () => {
    await expect(
      handleSetupCommand('mcp', {
        agent: 'claude-code',
        global: true,
        project: true,
      })
    ).rejects.toThrow('Choose either --global or --project');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('keeps project scope for an environment-backed credential', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    await handleSetupCommand('mcp', {
      agent: 'cursor',
      project: true,
      yes: true,
    });

    const args = vi.mocked(execFileSync).mock.calls[0]?.[1] as string[];
    expect(args).toContain('Authorization: Bearer ${env:FIRECRAWL_API_KEY}');
    expect(args).not.toContain('--global');
    expect(args.join(' ')).not.toContain('Bearer fc-test-key');
  });

  it('does not force global MCP scope in the default bundle when --project is set', async () => {
    vi.mocked(getApiKey).mockReturnValue(undefined);

    await handleSetupCommand(undefined, {
      agent: 'cursor',
      project: true,
      yes: true,
    });

    const mcpCall = vi
      .mocked(execFileSync)
      .mock.calls.find(([command]) => command === 'npx');
    expect(mcpCall?.[1]).not.toContain('--global');
  });

  it('does not force global when using an environment reference (no raw key in header)', async () => {
    // Env-backed cursor uses ${env:FIRECRAWL_API_KEY}, not the literal secret,
    // so project scope is safe and must not be silently overridden.
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    await handleSetupCommand('mcp', {
      agent: 'cursor',
      yes: true,
    });

    const args = vi.mocked(execFileSync).mock.calls[0]?.[1] as string[];
    expect(args.join(' ')).not.toContain('Bearer fc-test-key');
    expect(args).toContain('Authorization: Bearer ${env:FIRECRAWL_API_KEY}');
    expect(args).not.toContain('--global');
  });

  it('does not force global for the keyless (unauthenticated) setup', async () => {
    vi.mocked(getApiKey).mockReturnValue(undefined);

    await handleSetupCommand('mcp', {
      agent: 'claude-code',
      yes: true,
    });

    const args = vi.mocked(execFileSync).mock.calls[0]?.[1] as string[];
    expect(args.join(' ')).not.toContain('--header');
    expect(args).not.toContain('--global');
  });

  // --- Windows: launch .cmd/.exe shims correctly (execFileSync cannot) ---

  it('launches the npx.cmd shim via the shell on win32 with cmd-escaped args', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-win-'));
    const bin = path.join(root, 'Program Files', 'nodejs');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'npx.CMD'), '@exit /b 0\r\n');
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      'platform'
    );
    const originalPath = process.env.PATH;
    const originalPathext = process.env.PATHEXT;
    const originalComspec = process.env.ComSpec;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    process.env.PATH = bin;
    process.env.PATHEXT = '.EXE;.CMD';
    process.env.ComSpec = 'cmd.exe';
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    try {
      await handleSetupCommand('mcp', {
        agent: 'claude-code',
        global: true,
        yes: true,
      });

      const call = vi.mocked(execFileSync).mock.calls[0];
      const command = call?.[0] as string;
      const passthruArgs = call?.[1] as string[];
      const opts = call?.[2] as { windowsVerbatimArguments?: boolean };

      expect(command).toBe('cmd.exe');
      expect(passthruArgs.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(opts?.windowsVerbatimArguments).toBe(true);
      expect(passthruArgs[3]).toContain(`^\"${path.join(bin, 'npx.CMD')}^\"`);
      expect(passthruArgs[3]).toContain('add-mcp@1.14.0');
      expect(passthruArgs[3]).toContain(
        '^"Authorization: Bearer ${FIRECRAWL_API_KEY}^"'
      );
    } finally {
      if (originalPlatform)
        Object.defineProperty(process, 'platform', originalPlatform);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathext === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPathext;
      if (originalComspec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = originalComspec;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('launches a native Codex executable directly on win32', async () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-win-bin-'));
    const codexExe = path.join(bin, 'codex.EXE');
    writeFileSync(codexExe, '');
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      'platform'
    );
    const originalPath = process.env.PATH;
    const originalPathext = process.env.PATHEXT;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    process.env.PATH = bin;
    process.env.PATHEXT = '.EXE;.CMD';
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    try {
      await handleSetupCommand('mcp', {
        agent: 'codex',
        global: true,
        yes: true,
      });

      const call = vi.mocked(execFileSync).mock.calls[0];
      const command = call?.[0] as string;
      const args = call?.[1] as string[];
      const opts = call?.[2] as { windowsVerbatimArguments?: boolean };
      expect(command).toBe(codexExe);
      expect(args).toContain('--bearer-token-env-var');
      expect(opts?.windowsVerbatimArguments).toBeUndefined();
    } finally {
      if (originalPlatform)
        Object.defineProperty(process, 'platform', originalPlatform);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathext === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPathext;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('still spawns bare argv with no shell on non-win32', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';
    // Sanity: the pre-existing POSIX path is unchanged (argv-safe, no shell).
    await handleSetupCommand('mcp', {
      agent: 'claude-code',
      global: true,
      yes: true,
    });

    const call = vi.mocked(execFileSync).mock.calls[0];
    expect(call?.[0]).toBe('npx');
    expect(
      Array.isArray(call?.[1]) && (call?.[1] as string[]).length
    ).toBeGreaterThan(0);
    expect((call?.[2] as { shell?: boolean })?.shell).toBeUndefined();
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
      expect(installCalls.length).toBe(1);
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
