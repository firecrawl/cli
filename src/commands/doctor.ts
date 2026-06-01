/**
 * Doctor command — diagnostics for the Firecrawl CLI.
 *
 * Two modes:
 *   1. `firecrawl doctor` runs a pass/warn/fail checklist over the local
 *      environment (CLI version, auth, credits, MCP install, etc.) and exits
 *      non-zero if any check fails. Suitable as a CI / onboarding gate.
 *   2. `firecrawl doctor <job-id>` forwards to `/v2/support/ask` and renders
 *      the answer for a specific failed run.
 */

import { promises as fs } from 'fs';
import path from 'path';
import packageJson from '../../package.json';
import { getConfig } from '../utils/config';
import { isJobId } from '../utils/job';
import { detectAgents, type AgentDetection } from '../utils/agents';
import { compareVersions, getLatestVersion } from '../utils/npm-registry';
import { getAuthSource, type AuthSource } from './status';

type CheckStatus = 'pass' | 'warn' | 'fail';
type DoctorAuthSource = AuthSource | 'flag';

interface CheckResult {
  name: string;
  status: CheckStatus;
  /** Inline detail shown next to the check name. */
  message: string;
  /** Optional fix command shown beneath a warn/fail. */
  fix?: string;
}

export interface DoctorOptions {
  apiKey?: string;
  apiUrl?: string;
  /** Job ID to diagnose via /v2/support/ask. */
  jobId?: string;
  /** Optional override for the support query (mode 2). */
  query?: string;
  json?: boolean;
}

const DEFAULT_API_URL = 'https://api.firecrawl.dev';
const REACHABILITY_WARN_MS = 2000;
const MIN_NODE_MAJOR = 18;

function shouldUseColor(): boolean {
  if (process.env.FORCE_COLOR !== undefined) {
    return process.env.FORCE_COLOR !== '0';
  }
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === 'dumb') return false;
  return Boolean(process.stdout.isTTY);
}

const colorEnabled = shouldUseColor();
const color = (code: string): string => (colorEnabled ? code : '');

const orange = color('\x1b[38;5;208m');
const reset = color('\x1b[0m');
const dim = color('\x1b[2m');
const bold = color('\x1b[1m');
const green = color('\x1b[32m');
const red = color('\x1b[31m');
const yellow = color('\x1b[33m');

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case 'pass':
      return `${green}●${reset}`;
    case 'warn':
      return `${yellow}!${reset}`;
    case 'fail':
      return `${red}✗${reset}`;
  }
}

function maskApiKey(key: string): string {
  if (!key) return '';
  const tail = key.slice(-4);
  return `fc-...${tail}`;
}

function authSourceLabel(source: DoctorAuthSource): string {
  switch (source) {
    case 'flag':
      return 'flag';
    case 'env':
      return 'env';
    case 'stored':
      return 'stored';
    case 'none':
      return 'none';
  }
}

function trimApiUrl(url: string): string {
  return url.replace(/\/$/, '');
}

function dimParentheticals(message: string): string {
  return message.replace(/\(([^)]*)\)/g, `${dim}($1)${reset}`);
}

interface ApiPing {
  status: number;
  durationMs: number;
  error?: string;
  body?: unknown;
}

async function pingCreditUsage(
  apiKey: string,
  apiUrl: string
): Promise<ApiPing> {
  const url = `${trimApiUrl(apiUrl)}/v2/team/credit-usage`;
  const start = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    const durationMs = Date.now() - start;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, durationMs, body };
  } catch (error) {
    return {
      status: 0,
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function fetchQueueStatus(
  apiKey: string,
  apiUrl: string
): Promise<{
  ok: boolean;
  active?: number;
  max?: number;
  error?: string;
}> {
  const url = `${trimApiUrl(apiUrl)}/v2/team/queue-status`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as {
      success?: boolean;
      activeJobsInQueue?: number;
      maxConcurrency?: number;
    };
    if (!data.success || data.maxConcurrency === undefined) {
      return { ok: false, error: 'Invalid response' };
    }
    return {
      ok: true,
      active: data.activeJobsInQueue ?? 0,
      max: data.maxConcurrency,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function extractCredits(body: unknown): {
  remaining?: number;
  plan?: number;
} {
  if (!body || typeof body !== 'object') return {};
  const data = body as { data?: unknown; remainingCredits?: unknown };
  const root =
    data.data && typeof data.data === 'object'
      ? (data.data as Record<string, unknown>)
      : (data as Record<string, unknown>);
  const remaining =
    typeof root.remainingCredits === 'number'
      ? root.remainingCredits
      : undefined;
  const plan =
    typeof root.planCredits === 'number' ? root.planCredits : undefined;
  return { remaining, plan };
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

interface LocalEnv {
  envFileExists: boolean;
  envKey?: string;
  gitignoreExists: boolean;
  gitignoreHasFirecrawl: boolean;
  firecrawlDirExists: boolean;
}

async function readLocalEnv(cwd: string): Promise<LocalEnv> {
  const envPath = path.join(cwd, '.env');
  let envFileExists = false;
  let envKey: string | undefined;
  try {
    const content = await fs.readFile(envPath, 'utf8');
    envFileExists = true;
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(
        /^(?:export\s+)?FIRECRAWL_API_KEY\s*=\s*(.+)$/
      );
      if (match) {
        envKey = match[1].trim().replace(/^['"]/, '').replace(/['"]$/, '');
        break;
      }
    }
  } catch {
    envFileExists = false;
  }

  const gitignorePath = path.join(cwd, '.gitignore');
  let gitignoreExists = false;
  let gitignoreHasFirecrawl = false;
  try {
    const content = await fs.readFile(gitignorePath, 'utf8');
    gitignoreExists = true;
    gitignoreHasFirecrawl = content.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return /^\/?\.firecrawl(?:\/|$)/.test(trimmed);
    });
  } catch {
    gitignoreExists = false;
  }

  let firecrawlDirExists = false;
  try {
    const stat = await fs.stat(path.join(cwd, '.firecrawl'));
    firecrawlDirExists = stat.isDirectory();
  } catch {
    firecrawlDirExists = false;
  }

  return {
    envFileExists,
    envKey,
    gitignoreExists,
    gitignoreHasFirecrawl,
    firecrawlDirExists,
  };
}

function checkCliVersion(latest: {
  version?: string;
  unreachable: boolean;
}): CheckResult {
  const current = packageJson.version;
  if (latest.unreachable || !latest.version) {
    return {
      name: 'CLI Version',
      status: 'warn',
      message: `v${current} (registry unreachable)`,
    };
  }
  const cmp = compareVersions(current, latest.version);
  if (cmp >= 0) {
    return {
      name: 'CLI Version',
      status: 'pass',
      message: `v${current} (latest)`,
    };
  }
  return {
    name: 'CLI Version',
    status: 'warn',
    message: `v${current} (v${latest.version} available)`,
    fix: 'npm install -g firecrawl-cli',
  };
}

function checkNodeRuntime(): CheckResult {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0], 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    return {
      name: 'Node Runtime',
      status: 'fail',
      message: `v${version} (requires >=${MIN_NODE_MAJOR})`,
      fix: `Upgrade Node to >=${MIN_NODE_MAJOR}`,
    };
  }
  return {
    name: 'Node Runtime',
    status: 'pass',
    message: `v${version}`,
  };
}

function checkApiKey(
  apiKey: string | undefined,
  source: DoctorAuthSource
): CheckResult {
  if (!apiKey) {
    return {
      name: 'API Key',
      status: 'fail',
      message: `not found`,
      fix: 'firecrawl login',
    };
  }
  return {
    name: 'API Key',
    status: 'pass',
    message: `${maskApiKey(apiKey)} (${authSourceLabel(source)})`,
  };
}

function checkApiReachability(
  apiUrl: string,
  ping: ApiPing | null,
  isCustomUrl: boolean
): CheckResult {
  if (!ping) {
    return {
      name: 'API Reachability',
      status: 'fail',
      message: `not checked (no API key)`,
    };
  }
  if (ping.status === 0) {
    return {
      name: 'API Reachability',
      status: 'fail',
      message: `${apiUrl} (${ping.error || 'unreachable'})`,
      fix: 'Check network/DNS or firewall',
    };
  }
  if (isCustomUrl) {
    return {
      name: 'API Reachability',
      status: 'warn',
      message: `${apiUrl} (custom URL, ${ping.durationMs}ms)`,
    };
  }
  if (ping.durationMs > REACHABILITY_WARN_MS) {
    return {
      name: 'API Reachability',
      status: 'warn',
      message: `${ping.durationMs}ms (slow)`,
    };
  }
  return {
    name: 'API Reachability',
    status: 'pass',
    message: `${ping.durationMs}ms`,
  };
}

function checkApiKeyValidity(ping: ApiPing | null): CheckResult {
  if (!ping) {
    return {
      name: 'API Key Validity',
      status: 'fail',
      message: 'not checked',
    };
  }
  if (ping.status === 401 || ping.status === 403) {
    return {
      name: 'API Key Validity',
      status: 'fail',
      message: `HTTP ${ping.status} (invalid or revoked)`,
      fix: 'firecrawl login',
    };
  }
  if (ping.status === 0) {
    return {
      name: 'API Key Validity',
      status: 'fail',
      message: `could not reach API`,
    };
  }
  if (ping.status >= 200 && ping.status < 300) {
    return {
      name: 'API Key Validity',
      status: 'pass',
      message: 'accepted',
    };
  }
  return {
    name: 'API Key Validity',
    status: 'warn',
    message: `HTTP ${ping.status}`,
  };
}

function checkCredits(ping: ApiPing | null): CheckResult {
  if (!ping || ping.status === 0 || ping.status >= 400) {
    return {
      name: 'Credits',
      status: 'warn',
      message: 'unavailable',
    };
  }
  const { remaining, plan } = extractCredits(ping.body);
  if (remaining === undefined) {
    return {
      name: 'Credits',
      status: 'warn',
      message: 'no credit info in response',
    };
  }

  if (remaining === 0) {
    return {
      name: 'Credits',
      status: 'fail',
      message: '0 remaining',
      fix: 'Upgrade plan or buy credits at firecrawl.dev/pricing',
    };
  }

  if (plan && plan > 0) {
    const pct = (remaining / plan) * 100;
    const pctStr = pct > 100 ? 'above plan' : `${pct.toFixed(0)}% left`;
    const label = `${formatNumber(remaining)} / ${formatNumber(plan)} (${pctStr})`;
    if (pct < 10) {
      return { name: 'Credits', status: 'warn', message: label };
    }
    return { name: 'Credits', status: 'pass', message: label };
  }

  // Pay-as-you-go: warn under 100.
  const label = `${formatNumber(remaining)} (pay-as-you-go)`;
  if (remaining < 100) {
    return { name: 'Credits', status: 'warn', message: label };
  }
  return { name: 'Credits', status: 'pass', message: label };
}

function checkConcurrency(queue: {
  ok: boolean;
  active?: number;
  max?: number;
  error?: string;
}): CheckResult {
  if (!queue.ok || queue.max === undefined || queue.active === undefined) {
    return {
      name: 'Concurrency',
      status: 'fail',
      message: `queue endpoint error (${queue.error || 'unknown'})`,
    };
  }
  const label = `${queue.active}/${queue.max} jobs`;
  if (queue.active >= queue.max) {
    return {
      name: 'Concurrency',
      status: 'warn',
      message: `${label} (queueing)`,
    };
  }
  return {
    name: 'Concurrency',
    status: 'pass',
    message: label,
  };
}

function checkLocalEnv(local: LocalEnv, configuredKey?: string): CheckResult {
  if (!local.envFileExists) {
    return {
      name: 'Local .env',
      status: 'pass',
      message: `not present`,
    };
  }
  if (!local.envKey) {
    return {
      name: 'Local .env',
      status: 'pass',
      message: `present, FIRECRAWL_API_KEY not set`,
    };
  }
  if (configuredKey && configuredKey !== local.envKey) {
    return {
      name: 'Local .env',
      status: 'warn',
      message: `mismatches stored key`,
      fix: 'firecrawl env --overwrite',
    };
  }
  return {
    name: 'Local .env',
    status: 'pass',
    message: `FIRECRAWL_API_KEY set`,
  };
}

function checkGitignore(local: LocalEnv): CheckResult {
  if (!local.firecrawlDirExists) {
    return {
      name: '.gitignore',
      status: 'pass',
      message: `no .firecrawl/ to ignore`,
    };
  }
  if (!local.gitignoreExists) {
    return {
      name: '.gitignore',
      status: 'warn',
      message: `missing — .firecrawl/ present`,
      fix: 'echo .firecrawl/ >> .gitignore',
    };
  }
  if (!local.gitignoreHasFirecrawl) {
    return {
      name: '.gitignore',
      status: 'warn',
      message: `.firecrawl/ not ignored`,
      fix: 'echo .firecrawl/ >> .gitignore',
    };
  }
  return {
    name: '.gitignore',
    status: 'pass',
    message: '.firecrawl/ ignored',
  };
}

function checkAgents(agents: AgentDetection[]): CheckResult {
  const detected = agents.filter((a) => a.installed);
  if (detected.length === 0) {
    return {
      name: 'AI Agents',
      status: 'warn',
      message: 'none detected',
    };
  }
  return {
    name: 'AI Agents',
    status: 'pass',
    message: detected.map((a) => a.name).join(', '),
  };
}

function checkMcp(agents: AgentDetection[]): CheckResult {
  const detected = agents.filter((a) => a.installed);
  if (detected.length === 0) {
    return {
      name: 'MCP Server',
      status: 'warn',
      message: `no agents detected`,
    };
  }
  const registered = detected.filter((a) => a.mcpRegistered);
  if (registered.length === 0) {
    return {
      name: 'MCP Server',
      status: 'warn',
      message: `not registered in ${detected.map((a) => a.name).join(', ')}`,
      fix: 'firecrawl setup mcp',
    };
  }
  return {
    name: 'MCP Server',
    status: 'pass',
    message: `registered in ${registered.map((a) => a.name).join(', ')}`,
  };
}

/**
 * Run every health check. Exported for tests.
 */
export async function runChecks(options: DoctorOptions = {}): Promise<{
  checks: CheckResult[];
  apiUrl: string;
}> {
  const config = getConfig();
  const apiKey = options.apiKey || config.apiKey;
  const apiUrl = options.apiUrl || config.apiUrl || DEFAULT_API_URL;
  const isCustomUrl = trimApiUrl(apiUrl) !== DEFAULT_API_URL;
  const authSource: DoctorAuthSource = options.apiKey
    ? 'flag'
    : getAuthSource();

  const [latest, local, agents] = await Promise.all([
    getLatestVersion('firecrawl-cli'),
    readLocalEnv(process.cwd()),
    detectAgents(),
  ]);

  let ping: ApiPing | null = null;
  let queue: { ok: boolean; active?: number; max?: number; error?: string } = {
    ok: false,
    error: 'no API key',
  };
  if (apiKey) {
    [ping, queue] = await Promise.all([
      pingCreditUsage(apiKey, apiUrl),
      fetchQueueStatus(apiKey, apiUrl),
    ]);
  }

  const checks: CheckResult[] = [
    checkCliVersion(latest),
    checkNodeRuntime(),
    checkApiKey(apiKey, authSource),
    checkApiReachability(apiUrl, ping, isCustomUrl),
    checkApiKeyValidity(ping),
    checkCredits(ping),
    apiKey
      ? checkConcurrency(queue)
      : {
          name: 'Concurrency',
          status: 'fail' as const,
          message: 'not checked',
        },
    checkLocalEnv(local, apiKey),
    checkGitignore(local),
    checkAgents(agents),
    checkMcp(agents),
  ];

  return { checks, apiUrl };
}

function padName(name: string, width: number): string {
  if (name.length >= width) return name;
  return name + ' '.repeat(width - name.length);
}

function renderChecks(checks: CheckResult[]): void {
  const width = Math.max(...checks.map((c) => c.name.length)) + 2;

  console.log('');
  console.log(
    `  ${orange}🔥 ${bold}firecrawl${reset} ${dim}doctor v${packageJson.version}${reset}`
  );
  console.log('');

  for (const check of checks) {
    console.log(
      `  ${statusIcon(check.status)} ${padName(check.name, width)}${dimParentheticals(check.message)}`
    );
    if (check.fix) {
      console.log(`    ${dim}→ ${check.fix}${reset}`);
    }
  }

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status] += 1;

  console.log('');
  console.log(
    `  ${dim}${counts.pass} passed, ${counts.warn} warning${counts.warn === 1 ? '' : 's'}, ${counts.fail} failed${reset}`
  );
  console.log('');
}

/**
 * Mode 2: diagnose a specific run via /v2/support/ask.
 */
export async function runSupportAsk(options: DoctorOptions): Promise<number> {
  const config = getConfig();
  const apiKey = options.apiKey || config.apiKey;
  const apiUrl = options.apiUrl || config.apiUrl || DEFAULT_API_URL;
  const jobId = options.jobId!;
  const question = options.query || 'why did this run fail?';

  if (!apiKey) {
    console.error(
      `${red}Error:${reset} API key required for run diagnostics. Run \`firecrawl login\`.`
    );
    return 1;
  }

  const url = `${trimApiUrl(apiUrl)}/v2/support/ask`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question, jobId }),
    });
  } catch (error) {
    console.error(
      `${red}Error:${reset} could not reach support endpoint — ${
        error instanceof Error ? error.message : 'unknown error'
      }`
    );
    return 1;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
    console.error(`${red}Error:${reset} ${detail}`);
    return 1;
  }

  if (options.json) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }

  renderSupportAnswer(jobId, body);
  return 0;
}

function renderSupportAnswer(jobId: string, body: unknown): void {
  console.log('');
  console.log(
    `  ${orange}🔥 ${bold}firecrawl${reset} ${dim}doctor ${jobId}${reset}`
  );
  console.log('');

  if (!body || typeof body !== 'object') {
    console.log('  (empty response)');
    console.log('');
    return;
  }

  const obj = body as Record<string, unknown>;
  const answer =
    typeof obj.answer === 'string'
      ? obj.answer
      : typeof obj.message === 'string'
        ? obj.message
        : typeof obj.text === 'string'
          ? obj.text
          : null;

  if (answer) {
    for (const line of answer.split(/\r?\n/)) {
      console.log(`  ${line}`);
    }
  } else {
    console.log(`  ${JSON.stringify(body, null, 2)}`);
  }

  const sources = obj.sources ?? obj.docs ?? obj.links;
  if (Array.isArray(sources) && sources.length > 0) {
    console.log('');
    console.log(`  ${dim}Sources:${reset}`);
    for (const s of sources) {
      if (typeof s === 'string') {
        console.log(`    ${dim}- ${s}${reset}`);
      } else if (s && typeof s === 'object' && 'url' in s) {
        console.log(
          `    ${dim}- ${String((s as { url: unknown }).url)}${reset}`
        );
      }
    }
  }
  console.log('');
}

/**
 * Top-level command entrypoint.
 */
export async function handleDoctorCommand(
  options: DoctorOptions = {}
): Promise<void> {
  if (options.jobId) {
    const exitCode = await runSupportAsk(options);
    if (exitCode !== 0) process.exit(exitCode);
    return;
  }

  const { checks } = await runChecks(options);

  if (options.json) {
    console.log(JSON.stringify({ checks }, null, 2));
  } else {
    renderChecks(checks);
  }

  if (checks.some((c) => c.status === 'fail')) {
    process.exit(1);
  }
}
