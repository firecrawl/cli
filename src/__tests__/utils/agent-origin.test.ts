import { describe, it, expect, afterEach, vi } from 'vitest';
import packageJson from '../../../package.json';
import { buildCliOrigin, detectAgent } from '../../utils/agent-origin';

const version = packageJson.version;

describe('detectAgent', () => {
  it.each([
    [{ CLAUDECODE: '1' }, 'claude-code'],
    [{ CLAUDE_CODE_ENTRYPOINT: 'cli' }, 'claude-code'],
    [{ CODEX_SANDBOX: 'seatbelt' }, 'codex'],
    [{ CODEX_SANDBOX_NETWORK_DISABLED: '1' }, 'codex'],
    [{ CODEX_THREAD_ID: 'abc' }, 'codex'],
    [{ CODEX_MANAGED_BY_NPM: '1' }, 'codex'],
    [{ CURSOR_AGENT: '1' }, 'cursor'],
    [{ GEMINI_CLI: '1' }, 'gemini-cli'],
    [{ OPENCODE: '1' }, 'opencode'],
    [{ GOOSE_TERMINAL: '1' }, 'goose'],
    [{ CLINE_ACTIVE: 'true' }, 'cline'],
  ])('maps %j to %s', (env, slug) => {
    expect(detectAgent(env)).toBe(slug);
  });

  it('returns undefined without agent variables', () => {
    expect(detectAgent({ PATH: '/usr/bin', TERM_PROGRAM: 'vscode' })).toBe(
      undefined
    );
  });

  it('ignores empty and falsy values', () => {
    expect(detectAgent({ CLAUDECODE: '', GEMINI_CLI: '0' })).toBe(undefined);
    expect(detectAgent({ OPENCODE: 'false' })).toBe(undefined);
  });

  it('prefers the innermost agent when several are detected', () => {
    expect(detectAgent({ CLAUDECODE: '1', OPENCODE: '1' })).toBe('opencode');
  });

  it.each(['1', 'true', 'YES', 'on'])(
    'returns undefined when the opt-out is %s',
    (value) => {
      expect(
        detectAgent({
          CLAUDECODE: '1',
          FIRECRAWL_CLI_DISABLE_AGENT_ORIGIN: value,
        })
      ).toBe(undefined);
    }
  );

  it.each(['0', 'false', 'no', 'off', ''])(
    'keeps the agent when the opt-out is %j',
    (value) => {
      expect(
        detectAgent({
          CLAUDECODE: '1',
          FIRECRAWL_CLI_DISABLE_AGENT_ORIGIN: value,
        })
      ).toBe('claude-code');
    }
  );
});

describe('buildCliOrigin', () => {
  it('stamps the agent before the version', () => {
    expect(buildCliOrigin({ CURSOR_AGENT: '1' })).toBe(`cli.cursor@${version}`);
  });

  it('falls back to plain cli@<version>', () => {
    expect(buildCliOrigin({})).toBe(`cli@${version}`);
    expect(
      buildCliOrigin({
        GEMINI_CLI: '1',
        FIRECRAWL_CLI_DISABLE_AGENT_ORIGIN: '1',
      })
    ).toBe(`cli@${version}`);
  });
});

describe('getCliOrigin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('computes the origin once per process', async () => {
    vi.stubEnv('GEMINI_CLI', '1');
    vi.resetModules();
    const { getCliOrigin } = await import('../../utils/agent-origin');
    expect(getCliOrigin()).toBe(`cli.gemini-cli@${version}`);

    vi.stubEnv('GEMINI_CLI', '');
    vi.stubEnv('OPENCODE', '1');
    expect(getCliOrigin()).toBe(`cli.gemini-cli@${version}`);
  });
});
