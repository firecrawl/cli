import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'child_process';
import { handleInitCommand } from '../../commands/init';
import { installCliRouterCard } from '../../utils/router-card';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../utils/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true) };
});

vi.mock('../../utils/router-card', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/router-card')>();
  return {
    ...actual,
    installCliRouterCard: vi.fn(() => ({
      path: '/workspace/AGENTS.md',
      changed: true,
      version: 2,
      sha256:
        'f781e09b71c0d7f5a60f5bbf37a0c656cf30ade2876212a5f0dcde6bebaad995',
    })),
    resolveRouterCardProject: vi.fn((project: string) => project),
  };
});

describe('handleInitCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs skills from all repos globally across all detected agents in non-interactive mode', async () => {
    await handleInitCommand({
      yes: true,
      skipInstall: true,
      skipAuth: true,
    });

    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/cli --full-depth --global --all --yes',
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/skills --full-depth --global --all --yes',
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/firecrawl-workflows --full-depth --global --all --yes',
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('scopes non-interactive skills install to one agent across all repos when provided', async () => {
    await handleInitCommand({
      yes: true,
      skipInstall: true,
      skipAuth: true,
      agent: 'cursor',
    });

    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/cli --full-depth --global --yes --agent cursor',
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/skills --full-depth --global --yes --agent cursor',
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
    expect(execSync).toHaveBeenCalledWith(
      'npx -y skills add firecrawl/firecrawl-workflows --full-depth --global --yes --agent cursor',
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('installs the CLI-only router card by default after eligible project skills setup', async () => {
    await handleInitCommand({
      yes: true,
      skipInstall: true,
      skipAuth: true,
      agent: 'codex',
      project: '/workspace',
    });

    expect(installCliRouterCard).toHaveBeenCalledWith('codex', '/workspace');
  });

  it('honors the per-run router-card opt-out', async () => {
    await handleInitCommand({
      yes: true,
      skipInstall: true,
      skipAuth: true,
      agent: 'codex',
      project: '/workspace',
      routerCard: false,
    });

    expect(installCliRouterCard).not.toHaveBeenCalled();
  });

  it('does not write routing outside an explicit supported project state', async () => {
    await handleInitCommand({
      yes: true,
      skipInstall: true,
      skipAuth: true,
      agent: 'codex',
    });
    await handleInitCommand({
      yes: true,
      skipInstall: true,
      skipAuth: true,
      agent: 'cursor',
      project: '/workspace',
    });

    expect(installCliRouterCard).not.toHaveBeenCalled();
  });

  it('rejects router-card setup without an explicit project or skills', async () => {
    await expect(
      handleInitCommand({
        yes: true,
        skipInstall: true,
        skipAuth: true,
        agent: 'codex',
        routerCard: true,
      })
    ).rejects.toThrow('requires an explicit --project');

    await expect(
      handleInitCommand({
        yes: true,
        skipInstall: true,
        skipAuth: true,
        skipSkills: true,
        agent: 'codex',
        project: '/workspace',
        routerCard: true,
      })
    ).rejects.toThrow('requires skills');
  });
});
