import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { select } from '@inquirer/prompts';
import { handleLaunchCommand } from '../../commands/launch';
import { installMcp, installSkillsForAgent } from '../../commands/setup';
import { ALL_SKILL_REPOS } from '../../commands/skills-install';
import { getApiKey } from '../../utils/config';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
}));

vi.mock('../../commands/setup', () => ({
  installMcp: vi.fn(async () => undefined),
  installSkillsForAgent: vi.fn(async () => undefined),
}));

vi.mock('../../utils/config', () => ({
  getApiKey: vi.fn(() => undefined),
}));

describe('handleLaunchCommand', () => {
  const originalIsTty = process.stdin.isTTY;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getApiKey).mockReturnValue(undefined);
    originalApiKey = process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as never);
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = originalApiKey;
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: originalIsTty,
    });
  });

  function setStdinTty(value: boolean): () => void {
    const originalIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value,
    });
    return () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: originalIsTty,
      });
    };
  }

  it('installs Claude Code MCP without launching in install mode', async () => {
    await handleLaunchCommand('claude', { install: true });

    expect(installMcp).toHaveBeenCalledWith({
      agent: 'claude-code',
      global: true,
      yes: true,
      quiet: true,
    });
    expect(installSkillsForAgent).toHaveBeenCalledWith(
      'claude-code',
      {
        global: true,
        yes: true,
        nativeSkills: true,
        quiet: true,
      },
      ALL_SKILL_REPOS
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('supports setup and config as install-mode aliases', async () => {
    await handleLaunchCommand('claude', { setup: true });
    await handleLaunchCommand('codex', { config: true });

    expect(installMcp).toHaveBeenCalledTimes(2);
    expect(installSkillsForAgent).toHaveBeenCalledTimes(2);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('configures VS Code MCP and launches code with the current workspace', async () => {
    await handleLaunchCommand('code');

    expect(installMcp).toHaveBeenCalledWith({
      agent: 'vscode',
      global: true,
      yes: true,
      quiet: true,
    });
    expect(installSkillsForAgent).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenNthCalledWith(1, 'code', ['--version'], {
      stdio: 'ignore',
    });
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'code',
      ['.'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('warns when a GUI client may not inherit a launch-scoped stored key', async () => {
    vi.mocked(getApiKey).mockReturnValue('fc-stored-key');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await handleLaunchCommand('code', { skipSkills: true });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'may reuse an existing GUI process that cannot inherit the stored API key'
        )
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('passes extra arguments through to Codex', async () => {
    await handleLaunchCommand('codex', {}, ['--sandbox', 'workspace-write']);

    expect(installMcp).toHaveBeenCalledWith({
      agent: 'codex',
      global: true,
      yes: true,
      quiet: true,
    });
    expect(installSkillsForAgent).toHaveBeenCalledWith(
      'codex',
      {
        global: true,
        yes: true,
        nativeSkills: true,
        quiet: true,
      },
      ALL_SKILL_REPOS
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'codex',
      ['--sandbox', 'workspace-write'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('keeps a stored API key indirect while launching an agent with authenticated MCP', async () => {
    vi.mocked(getApiKey).mockReturnValue('fc-stored-key');

    await handleLaunchCommand('claude');

    expect(installMcp).toHaveBeenCalledWith(
      {
        agent: 'claude-code',
        global: true,
        yes: true,
        quiet: true,
      },
      expect.objectContaining({ FIRECRAWL_API_KEY: 'fc-stored-key' })
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'claude',
      [],
      expect.objectContaining({
        stdio: 'inherit',
        env: expect.objectContaining({ FIRECRAWL_API_KEY: 'fc-stored-key' }),
      })
    );
    expect(process.env.FIRECRAWL_API_KEY).toBeUndefined();
  });

  it('does not pretend a stored API key can persist beyond install-only mode', async () => {
    vi.mocked(getApiKey).mockReturnValue('fc-stored-key');
    vi.mocked(installMcp).mockRejectedValueOnce(
      new Error(
        'Secure MCP setup cannot persist a stored API key for future client sessions. Export FIRECRAWL_API_KEY, launch the client through "firecrawl launch <agent>", or configure keyless MCP.'
      )
    );

    await expect(
      handleLaunchCommand('claude', { install: true })
    ).rejects.toThrow('Export FIRECRAWL_API_KEY');

    expect(installMcp).toHaveBeenCalledWith({
      agent: 'claude-code',
      global: true,
      yes: true,
      quiet: true,
    });
    expect(spawnSync).not.toHaveBeenCalled();
    expect(process.env.FIRECRAWL_API_KEY).toBeUndefined();
  });

  it('asks which Codex setup to run and can install MCP only', async () => {
    const restoreStdin = setStdinTty(true);
    vi.mocked(select).mockResolvedValue('mcp');

    try {
      await handleLaunchCommand('codex', { install: true });
    } finally {
      restoreStdin();
    }

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Configure Firecrawl for Codex',
      })
    );
    expect(installMcp).toHaveBeenCalledWith({
      agent: 'codex',
      global: true,
      yes: true,
      quiet: true,
    });
    expect(installSkillsForAgent).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('asks which Codex setup to run and can install CLI skills only', async () => {
    const restoreStdin = setStdinTty(true);
    vi.mocked(select).mockResolvedValue('skills');

    try {
      await handleLaunchCommand('codex', { install: true });
    } finally {
      restoreStdin();
    }

    expect(installMcp).not.toHaveBeenCalled();
    expect(installSkillsForAgent).toHaveBeenCalledWith(
      'codex',
      {
        global: true,
        yes: true,
        nativeSkills: true,
        quiet: true,
      },
      ALL_SKILL_REPOS
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('configures Codex MCP and opens Codex App separately from the CLI', async () => {
    await handleLaunchCommand('codex-app');

    expect(installMcp).toHaveBeenCalledWith({
      agent: 'codex',
      global: true,
      yes: true,
      quiet: true,
    });
    expect(installSkillsForAgent).toHaveBeenCalledWith(
      'codex',
      {
        global: true,
        yes: true,
        nativeSkills: true,
        quiet: true,
      },
      ALL_SKILL_REPOS
    );
    expect(spawnSync).toHaveBeenNthCalledWith(1, 'open', ['--version'], {
      stdio: 'ignore',
    });
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'open',
      ['-b', 'com.openai.codex'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('does not pass extra arguments to Codex App', async () => {
    await expect(
      handleLaunchCommand('codex-app', {}, ['--foo'])
    ).rejects.toThrow('Codex App does not accept extra arguments');
  });

  it('can launch without touching MCP', async () => {
    await handleLaunchCommand('opencode', { skipMcp: true });

    expect(installMcp).not.toHaveBeenCalled();
    expect(installSkillsForAgent).toHaveBeenCalledWith(
      'opencode',
      {
        global: true,
        yes: true,
        nativeSkills: true,
        quiet: true,
      },
      ALL_SKILL_REPOS
    );
    expect(spawnSync).toHaveBeenNthCalledWith(1, 'opencode', ['--version'], {
      stdio: 'ignore',
    });
  });

  it('can skip skills for a launch target that normally supports them', async () => {
    await handleLaunchCommand('opencode', { skipMcp: true, skipSkills: true });

    expect(installMcp).not.toHaveBeenCalled();
    expect(installSkillsForAgent).not.toHaveBeenCalled();
  });

  it('does not claim MCP for a target Firecrawl does not configure', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await handleLaunchCommand('hermes', { install: true, skipSkills: true });

      const output = log.mock.calls.flat().join(' ');
      expect(output).toContain('Hermes Agent is set up.');
      expect(output).not.toContain('configured with Firecrawl MCP');
    } finally {
      log.mockRestore();
    }
  });

  it('still claims MCP for a target it does configure', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await handleLaunchCommand('codex', { install: true, skipSkills: true });

      expect(log.mock.calls.flat().join(' ')).toContain(
        'Codex is configured with Firecrawl MCP.'
      );
    } finally {
      log.mockRestore();
    }
  });

  it('does not claim MCP when the run skipped it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await handleLaunchCommand('codex', {
        install: true,
        skipMcp: true,
        skipSkills: true,
      });

      expect(log.mock.calls.flat().join(' ')).not.toContain(
        'configured with Firecrawl MCP'
      );
    } finally {
      log.mockRestore();
    }
  });

  it('configures Hermes MCP and skills, then launches Hermes Agent', async () => {
    await handleLaunchCommand('hermes');

    expect(installMcp).toHaveBeenCalledWith({
      agent: 'hermes',
      global: true,
      yes: true,
      quiet: true,
    });
    expect(installSkillsForAgent).toHaveBeenCalledWith(
      'hermes-agent',
      {
        global: true,
        yes: true,
        nativeSkills: true,
        quiet: true,
      },
      ALL_SKILL_REPOS
    );
    expect(spawnSync).toHaveBeenNthCalledWith(1, 'hermes', ['--version'], {
      stdio: 'ignore',
    });
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'hermes',
      [],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('passes a stored API key only through the launched Hermes process environment', async () => {
    vi.mocked(getApiKey).mockReturnValue('fc-stored-key');

    await handleLaunchCommand('hermes');

    expect(installMcp).toHaveBeenCalledWith(
      {
        agent: 'hermes',
        global: true,
        yes: true,
        quiet: true,
      },
      expect.objectContaining({ FIRECRAWL_API_KEY: 'fc-stored-key' })
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'hermes',
      [],
      expect.objectContaining({
        env: expect.objectContaining({ FIRECRAWL_API_KEY: 'fc-stored-key' }),
      })
    );
  });

  it('configures OpenClaw MCP and skills, then launches the TUI', async () => {
    await handleLaunchCommand('openclaw');

    expect(installMcp).toHaveBeenCalledWith({
      agent: 'openclaw',
      global: true,
      yes: true,
      quiet: true,
    });
    expect(installSkillsForAgent).toHaveBeenCalledWith(
      'openclaw',
      {
        global: true,
        yes: true,
        nativeSkills: true,
        quiet: true,
      },
      ALL_SKILL_REPOS
    );
    expect(spawnSync).toHaveBeenNthCalledWith(1, 'openclaw', ['--version'], {
      stdio: 'ignore',
    });
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'openclaw',
      ['tui'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('can skip skills for Hermes and OpenClaw launch targets', async () => {
    await handleLaunchCommand('hermes', { skipSkills: true });

    expect(installMcp).toHaveBeenCalledWith({
      agent: 'hermes',
      global: true,
      yes: true,
      quiet: true,
    });
    expect(installSkillsForAgent).not.toHaveBeenCalled();
  });

  it.each([
    ['claude', 'claude-code', 'claude', []],
    ['hermes', 'hermes', 'hermes', []],
    ['openclaw', 'openclaw', 'openclaw', ['tui']],
  ])(
    'can explicitly launch %s keyless without passing a stored API key to the client',
    async (target, mcpAgent, command, args) => {
      vi.mocked(getApiKey).mockReturnValue('fc-stored-key');

      await handleLaunchCommand(target, {
        keyless: true,
        skipSkills: true,
      });

      expect(installMcp).toHaveBeenCalledWith({
        agent: mcpAgent,
        global: true,
        yes: true,
        quiet: true,
        keyless: true,
      });
      expect(spawnSync).toHaveBeenNthCalledWith(
        2,
        command,
        args,
        expect.objectContaining({
          env: expect.not.objectContaining({
            FIRECRAWL_API_KEY: 'fc-stored-key',
          }),
        })
      );
    }
  );

  it('rejects contradictory keyless and skip-MCP options', async () => {
    await expect(
      handleLaunchCommand('claude', { keyless: true, skipMcp: true })
    ).rejects.toThrow('--keyless cannot be combined with --skip-mcp');

    expect(installMcp).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('requires an explicit target in non-interactive mode', async () => {
    const restoreStdin = setStdinTty(false);

    try {
      await expect(handleLaunchCommand()).rejects.toThrow(
        'Launch target is required in non-interactive mode'
      );
    } finally {
      restoreStdin();
    }
  });
});
