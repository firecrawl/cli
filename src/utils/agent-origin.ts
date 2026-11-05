/**
 * Request origin for API traffic: `cli.<agent>@<version>` when a coding agent
 * drives the CLI, `cli@<version>` otherwise.
 *
 * The agent comes from environment variables that agents set in the processes
 * they spawn, not from config files on disk (which only show an agent is
 * installed).
 */

import packageJson from '../../package.json';

// Innermost agents first; Claude Code's variables are the most widely inherited.
const AGENT_ENV: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'codex',
    [
      'CODEX_SANDBOX',
      'CODEX_SANDBOX_NETWORK_DISABLED',
      'CODEX_THREAD_ID',
      'CODEX_MANAGED_BY_NPM',
      'CODEX_MANAGED_BY_BUN',
      'CODEX_MANAGED_BY_PNPM',
      'CODEX_MANAGED_BY_VITE_PLUS',
    ],
  ],
  ['gemini-cli', ['GEMINI_CLI']],
  ['opencode', ['OPENCODE']],
  ['cursor', ['CURSOR_AGENT']],
  ['goose', ['GOOSE_TERMINAL']],
  ['cline', ['CLINE_ACTIVE']],
  ['claude-code', ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']],
];

function isSet(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return !!normalized && normalized !== '0' && normalized !== 'false';
}

export function detectAgent(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const optOut = env.FIRECRAWL_CLI_DISABLE_AGENT_ORIGIN?.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(optOut ?? '')) return undefined;
  return AGENT_ENV.find(([, vars]) =>
    vars.some((name) => isSet(env[name]))
  )?.[0];
}

export function buildCliOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const agent = detectAgent(env);
  return `cli${agent ? `.${agent}` : ''}@${packageJson.version}`;
}

let cachedOrigin: string | undefined;

export function getCliOrigin(): string {
  cachedOrigin ??= buildCliOrigin();
  return cachedOrigin;
}
