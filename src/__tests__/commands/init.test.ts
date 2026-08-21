import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
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
    getApiKeyMock.mockReturnValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
