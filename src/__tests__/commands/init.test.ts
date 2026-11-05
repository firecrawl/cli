import { detectGlobalSkillAgents } from '../../utils/skill-install-agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
import * as skillsNative from '../../commands/skills-native';
import {
  TEMPLATES,
  findTemplate,
  handleInitCommand,
  scaffoldTemplate,
} from '../../commands/init';
import { CLI_SKILLS, WORKFLOW_SKILLS } from '../../commands/skills-install';
import { getCatalogSkills } from '../../utils/skill-catalog';

const cliSkillFlags = `--skill ${CLI_SKILLS.join(' ')}`;
const workflowSkillFlags = `--skill ${WORKFLOW_SKILLS.join(' ')}`;

vi.mock('../../utils/skill-catalog', () => ({
  getCatalogSkills: vi.fn(async () => [
    ...CLI_SKILLS.map((name) => ({ name, family: 'core', files: {} })),
    ...WORKFLOW_SKILLS.map((name) => ({
      name,
      family: 'workflows',
      files: {},
    })),
  ]),
}));

const {
  installMcpMock,
  getApiKeyMock,
  confirmMock,
  checkboxMock,
  interactiveLoginMock,
} = vi.hoisted(() => ({
  installMcpMock: vi.fn(),
  getApiKeyMock: vi.fn(),
  confirmMock: vi.fn(),
  checkboxMock: vi.fn(),
  interactiveLoginMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../utils/skill-install-agents', () => ({
  detectGlobalSkillAgents: vi.fn(() => []),
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

vi.mock('../../utils/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/auth')>()),
  interactiveLogin: interactiveLoginMock,
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: confirmMock,
  checkbox: checkboxMock,
  select: vi.fn(),
}));

describe('handleInitCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(detectGlobalSkillAgents).mockReturnValue([]);
    vi.mocked(skillsNative.detectInstalledAgentNames).mockReturnValue([]);
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
      `npx -y skills@1.7.2 add firecrawl/skills --full-depth --global --yes --agent codex ${cliSkillFlags}`,
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills@1.7.2 add firecrawl/skills --full-depth --global --yes --agent codex ${workflowSkillFlags}`,
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
    // Build skills are intentionally no longer installed by init.
    expect(execSync).not.toHaveBeenCalledWith(
      expect.stringContaining('firecrawl-build'),
      expect.anything()
    );
  });

  it('installs skills before a non-interactive login that can fail or wait', async () => {
    interactiveLoginMock.mockRejectedValueOnce(new Error('No input'));

    await handleInitCommand({ yes: true, skipInstall: true });

    const skillOrders = vi.mocked(execSync).mock.invocationCallOrder;
    const loginOrder = interactiveLoginMock.mock.invocationCallOrder[0];
    expect(skillOrders).toHaveLength(2);
    expect(Math.max(...skillOrders)).toBeLessThan(loginOrder);
    expect(process.exitCode).toBe(1);
  });

  it('preserves detected targets when native installation falls back to npx', async () => {
    vi.mocked(skillsNative.detectInstalledAgentNames).mockReturnValue([
      'claude-code',
      'cursor',
    ]);

    vi.mocked(detectGlobalSkillAgents).mockReturnValue([
      'claude-code',
      'cursor',
    ]);

    await handleInitCommand({ yes: true, skipInstall: true, skipAuth: true });

    for (const flags of [cliSkillFlags, workflowSkillFlags]) {
      expect(execSync).toHaveBeenCalledWith(
        `npx -y skills@1.7.2 add firecrawl/skills --full-depth --global --yes --agent codex claude-code cursor ${flags}`,
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
      );
    }
  });

  it('scopes non-interactive skills install to one agent when provided', async () => {
    await handleInitCommand({
      yes: true,
      skipInstall: true,
      skipAuth: true,
      agent: 'cursor',
    });

    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills@1.7.2 add firecrawl/skills --full-depth --global --yes --agent cursor ${cliSkillFlags}`,
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills@1.7.2 add firecrawl/skills --full-depth --global --yes --agent cursor ${workflowSkillFlags}`,
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('installs newly published workflows during non-interactive init', async () => {
    vi.mocked(getCatalogSkills)
      .mockResolvedValueOnce(
        CLI_SKILLS.map((name) => ({ name, family: 'core', files: {} }))
      )
      .mockResolvedValueOnce([
        { name: 'firecrawl-new-workflow', family: 'workflows', files: {} },
      ]);
    await handleInitCommand({ yes: true, skipInstall: true, skipAuth: true });
    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills@1.7.2 add firecrawl/skills --full-depth --global --yes --agent codex --skill firecrawl-new-workflow',
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

  it('installs only the existing workflows selected during interactive init', async () => {
    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    checkboxMock
      .mockResolvedValueOnce(['workflows'])
      .mockResolvedValueOnce(['firecrawl-lead-gen', 'firecrawl-lead-research']);

    await handleInitCommand({
      skipInstall: true,
      skipAuth: true,
      agent: 'codex',
    });

    expect(checkboxMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        choices: expect.arrayContaining([
          expect.objectContaining({ value: 'firecrawl-lead-gen' }),
          expect.objectContaining({ value: 'firecrawl-lead-research' }),
        ]),
      })
    );
    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills@1.7.2 add firecrawl/skills --full-depth --global --yes --agent codex --skill firecrawl-lead-gen firecrawl-lead-research',
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it('continues interactive workflow installation when catalog discovery fails', async () => {
    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    checkboxMock
      .mockResolvedValueOnce(['workflows'])
      .mockResolvedValueOnce(['firecrawl-lead-research']);
    vi.mocked(getCatalogSkills).mockRejectedValueOnce(new Error('HTTP 403'));
    await handleInitCommand({ skipInstall: true, skipAuth: true });
    expect(checkboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Which workflow skills?',
        choices: WORKFLOW_SKILLS.map((name) => ({
          name,
          value: name,
          checked: true,
        })),
      })
    );
    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills@1.7.2 add firecrawl/skills --full-depth --global --yes --agent codex --skill firecrawl-lead-research',
      expect.anything()
    );
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

describe('init templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('only lists templates that are standalone public repositories', () => {
    expect(TEMPLATES.map((template) => template.repo)).toEqual([
      'firecrawl/open-lovable',
    ]);
    expect(findTemplate('open-lovable')?.repo).toBe('firecrawl/open-lovable');
  });

  it('rejects a template that is no longer offered without downloading anything', async () => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    expect(findTemplate('scrape-basic')).toBeUndefined();
    await expect(scaffoldTemplate('scrape-basic')).rejects.toThrow('exit 1');
    expect(execSync).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown template')
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('open-lovable')
    );
  });
});
