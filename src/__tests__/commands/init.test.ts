import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
import * as skillsNative from '../../commands/skills-native';
import { handleInitCommand } from '../../commands/init';
import { CLI_SKILLS, WORKFLOW_SKILLS } from '../../commands/skills-install';

const cliSkillFlags = `--skill ${CLI_SKILLS.join(' ')}`;
const workflowSkillFlags = `--skill ${WORKFLOW_SKILLS.join(' ')}`;

const { installMcpMock, getApiKeyMock, confirmMock, checkboxMock } = vi.hoisted(
  () => ({
    installMcpMock: vi.fn(),
    getApiKeyMock: vi.fn(),
    confirmMock: vi.fn(),
    checkboxMock: vi.fn(),
  })
);

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../commands/skills-native', () => ({
  detectInstalledAgentNames: vi.fn(() => []),
  hasNpx: vi.fn(() => true),
  installSkillsNative: vi.fn(async () => {
    throw new Error('Native install unavailable in this test');
  }),
}));

vi.mock('../../commands/setup', () => ({
  installMcp: installMcpMock,
}));

vi.mock('../../utils/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/config')>()),
  getApiKey: getApiKeyMock,
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: confirmMock,
  checkbox: checkboxMock,
  select: vi.fn(),
}));

describe('handleInitCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = 0;
    getApiKeyMock.mockReturnValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = 0;
  });

  it('installs CLI and workflow skills from the catalog globally across all detected agents in non-interactive mode', async () => {
    await handleInitCommand({
      yes: true,
      skipInstall: true,
      skipAuth: true,
    });

    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills add firecrawl/skills --full-depth --global --yes ${cliSkillFlags}`,
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills add firecrawl/skills --full-depth --global --yes ${workflowSkillFlags}`,
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
    // Build skills are intentionally no longer installed by init.
    expect(execSync).not.toHaveBeenCalledWith(
      expect.stringContaining('firecrawl-build'),
      expect.anything()
    );
  });

  it('scopes non-interactive skills install to one agent when provided', async () => {
    await handleInitCommand({
      yes: true,
      skipInstall: true,
      skipAuth: true,
      agent: 'cursor',
    });

    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills add firecrawl/skills --full-depth --global --yes --agent cursor ${cliSkillFlags}`,
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills add firecrawl/skills --full-depth --global --yes --agent cursor ${workflowSkillFlags}`,
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('summarizes interactive skills success even when npx output has no count', async () => {
    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    checkboxMock.mockResolvedValueOnce(['skills']);
    vi.mocked(execSync).mockReturnValueOnce(Buffer.from('Done'));
    await handleInitCommand({ skipInstall: true, skipAuth: true });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Skills installed')
    );
  });

  it('summarizes native interactive installation independently of its count', async () => {
    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    checkboxMock.mockResolvedValueOnce(['skills']);
    vi.mocked(skillsNative.installSkillsNative).mockResolvedValueOnce({
      skillCount: 14,
      linkedAgents: ['cursor'],
    } as Awaited<ReturnType<typeof skillsNative.installSkillsNative>>);
    await handleInitCommand({
      skipInstall: true,
      skipAuth: true,
      agent: 'cursor',
    });
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('14 skills')
    );
  });

  it('routes interactive MCP setup through the hardened hosted installer', async () => {
    getApiKeyMock.mockReturnValue('fc-stored-key');
    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    checkboxMock.mockResolvedValueOnce(['mcp']);
    installMcpMock.mockResolvedValueOnce(undefined);

    await handleInitCommand({
      skipInstall: true,
      skipAuth: true,
      global: true,
      agent: 'codex',
    });

    expect(installMcpMock).toHaveBeenCalledWith({
      global: true,
      agent: 'codex',
      yes: true,
      quiet: true,
      keyless: true,
    });
    expect(execSync).not.toHaveBeenCalledWith(
      expect.stringContaining('add-mcp'),
      expect.anything()
    );
  });

  it('does not print installer errors that could contain a stored credential', async () => {
    getApiKeyMock.mockReturnValue('fc-stored-key');
    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    checkboxMock.mockResolvedValueOnce(['mcp']);
    installMcpMock.mockRejectedValueOnce(
      new Error('installer failed for fc-stored-key')
    );

    await handleInitCommand({ skipInstall: true, skipAuth: true });

    expect(console.error).toHaveBeenCalledWith(
      '  Failed to install MCP securely: installer failed for [REDACTED]'
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'fc-stored-key'
    );
  });
});

describe('init global installation', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
    process.exitCode = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('npm_execpath', '');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = 0;
  });

  it.each([
    ['npm', '10.9.0', 'npm install -g firecrawl-cli'],
    ['pnpm', '10.12.1', 'pnpm add -g firecrawl-cli'],
    ['bun', '1.3.0', 'bun add -g firecrawl-cli'],
  ])('uses %s for global installation', async (manager, version, command) => {
    vi.stubEnv('npm_config_user_agent', `${manager}/${version}`);
    vi.mocked(execSync).mockReturnValue(Buffer.from(version));
    await handleInitCommand({ all: true, skipAuth: true, skipSkills: true });
    expect(execSync).toHaveBeenCalledWith(
      command,
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(process.exitCode).toBe(0);
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('Skills installed')
    );
  });

  it('preserves npm configuration during preflight, install, and bin discovery', async () => {
    vi.stubEnv('npm_config_user_agent', 'npm/10.9.0');
    vi.stubEnv('npm_config_prefix', '/tmp/custom-prefix');
    vi.stubEnv('npm_config_registry', 'https://registry.example.com');
    vi.stubEnv('npm_config__auth', 'test-only-auth');
    vi.mocked(execSync).mockImplementation((command) => {
      if (
        String(command).includes('firecrawl') &&
        !String(command).includes('install')
      )
        throw new Error('not on PATH');
      return Buffer.from(
        command === 'npm --version' ? '10.9.0' : '/tmp/custom-prefix'
      );
    });
    await handleInitCommand({ all: true, skipAuth: true, skipSkills: true });
    for (const command of [
      'npm --version',
      'npm install -g firecrawl-cli',
      'npm prefix -g',
    ]) {
      expect(execSync).toHaveBeenCalledWith(
        command,
        expect.objectContaining({
          env: expect.objectContaining({
            npm_config_prefix: '/tmp/custom-prefix',
            npm_config_registry: 'https://registry.example.com',
            npm_config__auth: 'test-only-auth',
          }),
        })
      );
    }
  });

  it('rejects obsolete npm before installation and exits unsuccessfully', async () => {
    vi.stubEnv('npm_config_user_agent', 'npm/2.15.12');
    vi.mocked(execSync).mockReturnValue(Buffer.from('2.15.12'));
    await handleInitCommand({ all: true, skipAuth: true, skipSkills: true });
    expect(execSync).not.toHaveBeenCalledWith(
      'npm install -g firecrawl-cli',
      expect.anything()
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unsupported npm version 2.15.12')
    );
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ['npm', 'npx firecrawl-cli'],
    ['pnpm', 'pnpm dlx firecrawl-cli'],
    ['bun', 'bunx firecrawl-cli'],
  ])(
    'reports a failed %s install and preserves successful skills',
    async (manager, runner) => {
      vi.stubEnv('npm_config_user_agent', `${manager}/10.0.0`);
      vi.mocked(execSync).mockImplementation((command) => {
        if (String(command).includes(' -g firecrawl-cli'))
          throw new Error('install failed');
        return Buffer.from(
          String(command).endsWith('--version')
            ? '10.0.0'
            : 'Installed 14 skills'
        );
      });
      await handleInitCommand({ all: true, skipAuth: true });
      expect(process.exitCode).toBe(1);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(`${runner} <command>`)
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('28 skills')
      );
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Setup incomplete: global CLI installation failed'
        )
      );
      expect(console.error).not.toHaveBeenCalledWith(
        expect.stringContaining('sudo')
      );
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('running via npx')
      );
    }
  );
});
