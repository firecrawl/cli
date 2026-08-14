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
import {
  MCP_CLIENTS,
  RULE_MARKER,
  type McpClientId,
} from '../../utils/mcp-clients';

const MCP_URL = 'https://mcp.firecrawl.dev/v2/mcp';

/** Where a given agent's global config lands on this platform. */
function globalConfigPath(id: McpClientId, home: string): string {
  return MCP_CLIENTS[id].globalConfigPath({
    home,
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env,
    auth: 'keyless',
  });
}

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

vi.mock('@inquirer/prompts', () => ({
  checkbox: vi.fn(),
  confirm: vi.fn(),
}));

describe('handleSetupCommand', () => {
  let originalHome: string | undefined;
  let originalApiKey: string | undefined;
  let sandboxHome: string;
  let originalPath: string | undefined;
  let originalUserProfile: string | undefined;
  let originalAppData: string | undefined;
  let originalCwd: string;
  let sandboxCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations, so a test that makes a spawn throw
    // would leak that behaviour into every test after it.
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execSync).mockReset();
    vi.mocked(getApiKey).mockReturnValue('fc-test-key');
    vi.mocked(isAuthenticated).mockReturnValue(true);
    vi.mocked(browserLogin).mockResolvedValue({
      apiKey: 'fc-browser-key',
      apiUrl: 'https://api.firecrawl.dev',
    });
    originalHome = process.env.HOME;
    originalApiKey = process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    // MCP setup writes real agent config files, so every test gets a throwaway
    // home. Without this a test run would rewrite the developer's own editors.
    sandboxHome = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-home-'));
    process.env.HOME = sandboxHome;
    // os.homedir() reads USERPROFILE on Windows, and app-support paths read
    // APPDATA, so HOME alone would leave a Windows run writing the real profile.
    originalUserProfile = process.env.USERPROFILE;
    originalAppData = process.env.APPDATA;
    process.env.USERPROFILE = sandboxHome;
    process.env.APPDATA = path.join(sandboxHome, 'AppData', 'Roaming');
    // Project scope writes relative to cwd, so a run must not be able to drop
    // config files into the repository itself.
    originalCwd = process.cwd();
    sandboxCwd = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-cwd-'));
    process.chdir(sandboxCwd);
    // Launcher detection also looks on PATH, so pin it for the same reason.
    originalPath = process.env.PATH;
    process.env.PATH = '';
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(sandboxCwd, { recursive: true, force: true });
    rmSync(sandboxHome, { recursive: true, force: true });
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
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
    mkdirSync(path.join(sandboxHome, '.cursor'), { recursive: true });

    await handleSetupCommand(undefined, { yes: true });

    expect(execSync).toHaveBeenCalledWith(
      `npx -y skills add firecrawl/skills --full-depth --global --yes ${cliSkillFlags}`,
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(
      JSON.parse(
        readFileSync(path.join(sandboxHome, '.cursor', 'mcp.json'), 'utf-8')
      ).mcpServers.firecrawl
    ).toEqual({ url: MCP_URL });
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

  it('configures keyless when only a stored API key is available', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-stored-'));
    process.env.HOME = home;

    try {
      await handleSetupCommand('mcp', {
        agent: 'claude-code',
        global: true,
        yes: true,
      });

      // An agent cannot resolve a key that only lives in our credential
      // store, so nothing is written rather than persisting a literal.
      const config = readFileSync(path.join(home, '.claude.json'), 'utf-8');
      expect(JSON.parse(config).mcpServers.firecrawl).toEqual({
        type: 'http',
        url: MCP_URL,
      });
      expect(config).not.toContain('fc-test-key');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('can explicitly install keyless MCP without exposing a stored API key', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-keyless-'));
    process.env.HOME = home;
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    try {
      await installMcp({
        agent: 'claude-code',
        global: true,
        yes: true,
        keyless: true,
      });

      const config = readFileSync(path.join(home, '.claude.json'), 'utf-8');
      expect(config).not.toContain('fc-test-key');
      expect(config).not.toContain('Authorization');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('accepts a launch-scoped environment while keeping the key out of MCP config', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-launch-env-'));
    process.env.HOME = home;

    try {
      await installMcp(
        { agent: 'claude-code', global: true, yes: true },
        { ...process.env, FIRECRAWL_API_KEY: 'fc-test-key' }
      );

      const config = readFileSync(path.join(home, '.claude.json'), 'utf-8');
      expect(JSON.parse(config).mcpServers.firecrawl.headers).toEqual({
        Authorization: 'Bearer ${FIRECRAWL_API_KEY}',
      });
      expect(config).not.toContain('fc-test-key');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('normalizes launch aliases for environment-backed MCP setup', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-alias-'));
    process.env.HOME = home;
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    try {
      await handleSetupCommand('mcp', {
        agent: 'codex-app',
        global: true,
        yes: true,
      });

      const config = readFileSync(
        path.join(home, '.codex', 'config.toml'),
        'utf-8'
      );
      expect(config).toContain('[mcp_servers.firecrawl]');
      expect(config).toContain('bearer_token_env_var = "FIRECRAWL_API_KEY"');
      expect(config).not.toContain('fc-test-key');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ['claude-code', 'claude', 'mcpServers', 'Bearer ${FIRECRAWL_API_KEY}'],
    ['vscode', 'vscode', 'servers', 'Bearer ${env:FIRECRAWL_API_KEY}'],
    ['cursor', 'cursor', 'mcpServers', 'Bearer ${env:FIRECRAWL_API_KEY}'],
    ['opencode', 'opencode', 'mcp', 'Bearer {env:FIRECRAWL_API_KEY}'],
  ] as const)(
    'uses the %s environment reference when the API key came from the environment',
    async (agent, id, serversKey, header) => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-envref-'));
      process.env.HOME = home;
      process.env.FIRECRAWL_API_KEY = 'fc-test-key';

      try {
        await handleSetupCommand('mcp', { agent, global: true, yes: true });

        const config = readFileSync(globalConfigPath(id, home), 'utf-8');
        expect(JSON.parse(config)[serversKey].firecrawl.headers).toEqual({
          Authorization: header,
        });
        expect(config).not.toContain('fc-test-key');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  );

  it('uses Codex native environment-backed bearer configuration', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-codex-env-'));
    process.env.HOME = home;
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    try {
      await handleSetupCommand('mcp', {
        agent: 'codex',
        global: true,
        yes: true,
      });

      const config = readFileSync(
        path.join(home, '.codex', 'config.toml'),
        'utf-8'
      );
      expect(config).toContain('bearer_token_env_var = "FIRECRAWL_API_KEY"');
      expect(config).not.toContain('fc-test-key');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('installs MCP with the keyless hosted Firecrawl URL without credentials', async () => {
    vi.mocked(getApiKey).mockReturnValue(undefined);
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-nokey-'));
    process.env.HOME = home;

    try {
      await handleSetupCommand('mcp', {
        agent: 'claude-code',
        global: true,
        yes: true,
      });

      expect(
        JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf-8'))
          .mcpServers.firecrawl
      ).toEqual({ type: 'http', url: MCP_URL });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('lists only detected agents in the picker, already selected', async () => {
    mkdirSync(path.join(sandboxHome, '.cursor'), { recursive: true });
    mkdirSync(path.join(sandboxHome, '.codex'), { recursive: true });

    const { checkbox, confirm } = await import('@inquirer/prompts');
    vi.mocked(checkbox).mockResolvedValue(['cursor']);
    vi.mocked(confirm).mockResolvedValue(false);

    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });

    try {
      await handleSetupCommand('mcp', {});

      expect(checkbox).toHaveBeenCalledOnce();
      expect(vi.mocked(checkbox).mock.calls[0]?.[0]).toMatchObject({
        choices: [
          { value: 'cursor', checked: true },
          { value: 'codex', checked: true },
        ],
      });
      expect(existsSync(path.join(sandboxHome, '.cursor', 'mcp.json'))).toBe(
        true
      );
      expect(existsSync(path.join(sandboxHome, '.hermes', 'config.yaml'))).toBe(
        false
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: originalIsTTY,
      });
    }
  });

  it('surfaces total failure even in quiet mode', async () => {
    mkdirSync(path.join(sandboxHome, '.cursor'), { recursive: true });
    writeFileSync(path.join(sandboxHome, '.cursor', 'mcp.json'), '{ broken');

    // init and launch both pass quiet, and must not report success when
    // nothing was written.
    await expect(
      installMcp({ clients: ['cursor'], yes: true, quiet: true, keyless: true })
    ).rejects.toThrow('Failed to configure Firecrawl MCP');
  });

  it('configures every client with --agent all, detected or not', async () => {
    await handleSetupCommand('mcp', {
      agent: 'all',
      global: true,
      yes: true,
      keyless: true,
    });

    for (const id of [
      'claude',
      'cursor',
      'codex',
      'vscode',
      'opencode',
    ] as const) {
      expect(existsSync(globalConfigPath(id, sandboxHome))).toBe(true);
    }
  });

  it('skips MCP for a skills-only agent instead of failing the run', async () => {
    // Skills already installed by this point in `setup --yes --agent windsurf`.
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      handleSetupCommand('mcp', { agent: 'windsurf', yes: true })
    ).resolves.toBeUndefined();

    expect(log.mock.calls.flat().join(' ')).toContain(
      'https://mcp.firecrawl.dev/v2/mcp'
    );
  });

  it('still rejects an agent name nothing supports', async () => {
    await expect(
      handleSetupCommand('mcp', { agent: 'not-an-agent', yes: true })
    ).rejects.toThrow('Unknown agent');
  });

  it('suppresses Hermes installer logs in quiet mode', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await installMcp({ agent: 'hermes', quiet: true, keyless: true });
      expect(log.mock.calls.flat().join('\n')).not.toContain(
        'Hermes Agent MCP configured'
      );
    } finally {
      log.mockRestore();
    }
  });

  it('points every agent at the sign-in endpoint with --oauth', async () => {
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';
    for (const dir of ['.claude', '.cursor', '.codex', '.hermes']) {
      mkdirSync(path.join(sandboxHome, dir), { recursive: true });
    }

    await handleSetupCommand('mcp', { oauth: true, yes: true } as never);

    const claude = readFileSync(
      path.join(sandboxHome, '.claude.json'),
      'utf-8'
    );
    expect(claude).toContain('/v2/mcp-oauth');
    // Sign-in replaces the credential rather than travelling beside it.
    expect(claude).not.toContain('Authorization');
    expect(claude).not.toContain('fc-test-key');

    // Codex takes a bare URL; its sign-in is a separate login command.
    expect(
      readFileSync(path.join(sandboxHome, '.codex', 'config.toml'), 'utf-8')
    ).toContain('/v2/mcp-oauth');
  });

  it('refuses to combine sign-in with keyless', async () => {
    await expect(
      handleSetupCommand('mcp', {
        clients: ['cursor'],
        oauth: true,
        keyless: true,
        yes: true,
      } as never)
    ).rejects.toThrow(/either --oauth or --keyless/);
  });

  it('rejects that combination for an agent it only prints a URL for', async () => {
    // This path returns early, so the check has to run ahead of it.
    await expect(
      handleSetupCommand('mcp', {
        urlOnly: ['hermes'],
        oauth: true,
        keyless: true,
        yes: true,
      } as never)
    ).rejects.toThrow(/either --oauth or --keyless/);
  });

  it('prints the server URL for an agent it does not configure', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      // Naming one is not an error, and nothing is written for it.
      await handleSetupCommand('mcp', {
        urlOnly: ['hermes'],
        yes: true,
      } as never);

      expect(log.mock.calls.flat().join(' ')).toContain(MCP_URL);
      expect(existsSync(path.join(sandboxHome, '.hermes'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('accepts those agents by name as well as by flag', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      for (const agent of ['hermes', 'hermes-agent', 'openclaw']) {
        await handleSetupCommand('mcp', { agent, yes: true });
      }

      expect(log.mock.calls.flat().join(' ')).toContain(MCP_URL);
      expect(existsSync(path.join(sandboxHome, '.openclaw'))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('still configures the writers when both kinds are named', async () => {
    mkdirSync(path.join(sandboxHome, '.cursor'), { recursive: true });

    await handleSetupCommand('mcp', {
      clients: ['cursor'],
      urlOnly: ['openclaw'],
      yes: true,
    } as never);

    expect(
      JSON.parse(readFileSync(globalConfigPath('cursor', sandboxHome), 'utf-8'))
        .mcpServers.firecrawl.url
    ).toBe(MCP_URL);
  });

  it('sends the sign-in URL for an agent it does not configure', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await handleSetupCommand('mcp', {
        urlOnly: ['openclaw'],
        oauth: true,
        yes: true,
      } as never);

      expect(log.mock.calls.flat().join(' ')).toContain(`${MCP_URL}-oauth`);
    } finally {
      log.mockRestore();
    }
  });

  it('uses each client native environment binding with --agent all', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-all-env-test-'));
    // Make several agents detectable so --agent all has editors to configure.
    for (const dir of ['.claude', '.cursor', '.codex']) {
      mkdirSync(path.join(home, dir), { recursive: true });
    }
    process.env.HOME = home;
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    try {
      await handleSetupCommand('mcp', {
        agent: 'all',
        global: true,
        yes: true,
      });

      const claude = readFileSync(path.join(home, '.claude.json'), 'utf-8');
      const cursor = readFileSync(
        path.join(home, '.cursor', 'mcp.json'),
        'utf-8'
      );
      const codex = readFileSync(
        path.join(home, '.codex', 'config.toml'),
        'utf-8'
      );
      expect(JSON.parse(claude).mcpServers.firecrawl.headers).toEqual({
        Authorization: 'Bearer ${FIRECRAWL_API_KEY}',
      });
      expect(JSON.parse(cursor).mcpServers.firecrawl.headers).toEqual({
        Authorization: 'Bearer ${env:FIRECRAWL_API_KEY}',
      });
      expect(codex).toContain('bearer_token_env_var = "FIRECRAWL_API_KEY"');
      expect(`${claude}${cursor}${codex}`).not.toContain('fc-test-key');
      // `all` covers every agent setup writes for, and nothing else.
      expect(existsSync(path.join(home, '.hermes', 'config.yaml'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps keyless --agent all setup available', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-all-keyless-'));
    process.env.HOME = home;
    vi.mocked(getApiKey).mockReturnValue(undefined);

    try {
      await handleSetupCommand('mcp', {
        agent: 'all',
        yes: true,
      });

      expect(readFileSync(globalConfigPath('cursor', home), 'utf-8')).toContain(
        MCP_URL
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('configures every detected agent when no --agent is given', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-noagent-'));
    mkdirSync(path.join(home, '.cursor'), { recursive: true });
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    process.env.HOME = home;
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    try {
      // Knowing each selected agent means each gets its own native syntax,
      // so no explicit --agent is required.
      await handleSetupCommand('mcp', { global: true, yes: true });

      expect(
        JSON.parse(
          readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf-8')
        ).mcpServers.firecrawl.headers
      ).toEqual({ Authorization: 'Bearer ${env:FIRECRAWL_API_KEY}' });
      expect(
        JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf-8'))
          .mcpServers.firecrawl.headers
      ).toEqual({ Authorization: 'Bearer ${FIRECRAWL_API_KEY}' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ['an environment-backed key', true],
    ['a stored key', false],
  ])('rejects an unknown client with %s', async (_label, fromEnv) => {
    if (fromEnv) process.env.FIRECRAWL_API_KEY = 'fc-test-key';

    await expect(
      handleSetupCommand('mcp', {
        agent: 'future-client',
        global: true,
        yes: true,
      })
    ).rejects.toThrow('Unknown agent');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('never includes environment-backed credentials in config or normal output', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-no-leak-'));
    process.env.HOME = home;
    process.env.FIRECRAWL_API_KEY = 'fc-test-key';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await handleSetupCommand('mcp', {
        agent: 'claude-code',
        global: true,
        yes: true,
      });

      const config = readFileSync(path.join(home, '.claude.json'), 'utf-8');
      expect(config).toContain(MCP_URL);
      expect(config).not.toContain('fc-test-key');
      expect(log.mock.calls.flat().join(' ')).not.toContain('fc-test-key');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('never places a stored API key in config or argv', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-stored-argv-'));
    process.env.HOME = home;

    try {
      await handleSetupCommand('mcp', {
        agent: 'claude-code',
        global: true,
        yes: true,
      });

      expect(
        readFileSync(path.join(home, '.claude.json'), 'utf-8')
      ).not.toContain('fc-test-key');
      expect(
        vi.mocked(execFileSync).mock.calls.flat(2).join(' ')
      ).not.toContain('fc-test-key');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes MCP into global agent config', async () => {
    vi.mocked(getApiKey).mockReturnValue(undefined);
    const home = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-global-'));
    process.env.HOME = home;

    try {
      await handleSetupCommand('mcp', { agent: 'claude-code', yes: true });

      const config = readFileSync(path.join(home, '.claude.json'), 'utf-8');
      expect(config).not.toContain('Authorization');
      expect(config).toContain(MCP_URL);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // --- Windows: launch .cmd/.exe shims correctly (execFileSync cannot) ---

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
