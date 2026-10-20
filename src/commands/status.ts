/**
 * Status command implementation
 * Displays CLI version, auth status, concurrency, and credits
 */

import { promises as fs } from 'fs';
import path from 'path';
import packageJson from '../../package.json';
import { isAuthenticated } from '../utils/auth';
import { getConfig, validateConfig } from '../utils/config';
import { loadCredentials } from '../utils/credentials';
import { isSearchFeedbackDisabledLocally } from './search-feedback';
import { integrationHeaders } from '../utils/integration';

export type AuthSource = 'env' | 'stored' | 'none';

interface QueueStatusResponse {
  success: boolean;
  jobsInQueue?: number;
  activeJobsInQueue?: number;
  waitingJobsInQueue?: number;
  maxConcurrency?: number;
  mostRecentSuccess?: string | null;
}

interface CreditUsageResponse {
  success: boolean;
  data?: {
    remainingCredits: number;
    planCredits: number;
    billingPeriodStart: string | null;
    billingPeriodEnd: string | null;
  };
}

interface StatusResult {
  version: string;
  authenticated: boolean;
  authSource: AuthSource;
  concurrency?: {
    active: number;
    max: number;
  };
  credits?: {
    remaining: number;
    plan: number;
  };
  error?: string;
}

interface LocalStatus {
  gitignoreExists: boolean;
  gitignoreHasFirecrawl: boolean;
  firecrawlDirExists: boolean;
  firecrawlFileCount: number;
}

/**
 * Detect how the user is authenticated
 */
export function getAuthSource(): AuthSource {
  if (process.env.FIRECRAWL_API_KEY) {
    return 'env';
  }
  const stored = loadCredentials();
  if (stored?.apiKey) {
    return 'stored';
  }
  return 'none';
}

/**
 * Fetch queue status from API
 */
async function fetchQueueStatus(
  apiKey: string,
  apiUrl: string
): Promise<QueueStatusResponse> {
  const url = `${apiUrl.replace(/\/$/, '')}/v2/team/queue-status`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...integrationHeaders(),
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.error || `HTTP ${response.status}: ${response.statusText}`
    );
  }

  return response.json();
}

/**
 * Fetch credit usage from API
 */
async function fetchCreditUsage(
  apiKey: string,
  apiUrl: string
): Promise<CreditUsageResponse> {
  const url = `${apiUrl.replace(/\/$/, '')}/v2/team/credit-usage`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...integrationHeaders(),
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.error || `HTTP ${response.status}: ${response.statusText}`
    );
  }

  return response.json();
}

/**
 * Get full status information
 */
export async function getStatus(): Promise<StatusResult> {
  const authSource = getAuthSource();
  const result: StatusResult = {
    version: packageJson.version,
    authenticated: isAuthenticated(),
    authSource,
  };

  if (!result.authenticated) {
    return result;
  }

  try {
    const config = getConfig();
    const apiKey = config.apiKey;
    validateConfig(apiKey);

    const apiUrl = config.apiUrl || 'https://api.firecrawl.dev';

    // Fetch both endpoints in parallel
    const [queueStatus, creditUsage] = await Promise.all([
      fetchQueueStatus(apiKey!, apiUrl),
      fetchCreditUsage(apiKey!, apiUrl),
    ]);

    if (queueStatus.success && queueStatus.maxConcurrency !== undefined) {
      result.concurrency = {
        active: queueStatus.activeJobsInQueue || 0,
        max: queueStatus.maxConcurrency,
      };
    }

    if (creditUsage.success && creditUsage.data) {
      result.credits = {
        remaining: creditUsage.data.remainingCredits,
        plan: creditUsage.data.planCredits,
      };
    }
  } catch (error: any) {
    result.error = error?.message || 'Failed to fetch status';
  }

  return result;
}

/**
 * Format number with thousand separators
 */
function formatNumber(num: number): string {
  return num.toLocaleString('en-US');
}

/**
 * Check local repo status for .gitignore and .firecrawl
 */
async function getLocalStatus(cwd: string): Promise<LocalStatus> {
  const gitignorePath = path.join(cwd, '.gitignore');
  let gitignoreExists = false;
  let gitignoreHasFirecrawl = false;

  try {
    const content = await fs.readFile(gitignorePath, 'utf8');
    gitignoreExists = true;
    const lines = content.split(/\r?\n/);
    gitignoreHasFirecrawl = lines.some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        return false;
      }
      return /^\/?\.firecrawl(?:\/|$)/.test(trimmed);
    });
  } catch {
    gitignoreExists = false;
  }

  const firecrawlDir = path.join(cwd, '.firecrawl');
  let firecrawlDirExists = false;
  let firecrawlFileCount = 0;

  async function countFiles(dir: string): Promise<number> {
    let count = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'scratchpad') {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += await countFiles(fullPath);
      } else if (entry.isFile()) {
        if (!entry.name.startsWith('.')) {
          count += 1;
        }
      }
    }
    return count;
  }

  try {
    const stat = await fs.stat(firecrawlDir);
    if (stat.isDirectory()) {
      firecrawlDirExists = true;
      firecrawlFileCount = await countFiles(firecrawlDir);
    }
  } catch {
    firecrawlDirExists = false;
  }

  return {
    gitignoreExists,
    gitignoreHasFirecrawl,
    firecrawlDirExists,
    firecrawlFileCount,
  };
}

/**
 * Handle status command output
 */
export async function handleStatusCommand(): Promise<void> {
  const orange = '\x1b[38;5;208m';
  const reset = '\x1b[0m';
  const dim = '\x1b[2m';
  const bold = '\x1b[1m';
  const green = '\x1b[32m';
  const red = '\x1b[31m';

  const status = await getStatus();
  const localStatus = await getLocalStatus(process.cwd());

  // Header
  console.log('');
  console.log(
    `  ${orange}🔥 ${bold}firecrawl${reset} ${dim}cli${reset} ${dim}v${status.version}${reset}`
  );
  console.log('');

  // Auth status with source
  if (status.authenticated) {
    const sourceLabel =
      status.authSource === 'env'
        ? 'via FIRECRAWL_API_KEY'
        : 'via stored credentials';
    console.log(
      `  ${green}●${reset} Authenticated ${dim}${sourceLabel}${reset}`
    );
  } else {
    console.log(`  ${red}●${reset} Not authenticated`);
    console.log(`  ${dim}Run 'firecrawl login' to authenticate${reset}`);
    console.log('');
    if (localStatus.firecrawlDirExists) {
      console.log(
        `  ${dim}.firecrawl:${reset} present ${dim}- ${formatNumber(localStatus.firecrawlFileCount)} sites${reset}`
      );
    } else {
      console.log(
        `  ${dim}.firecrawl:${reset} not found ${dim}- no local cache${reset}`
      );
    }
    if (localStatus.gitignoreExists) {
      const ignoredLabel = localStatus.gitignoreHasFirecrawl ? 'yes' : 'no';
      console.log(
        `  ${dim}.gitignore:${reset} present ${dim}- .firecrawl ignored: ${ignoredLabel}${reset}`
      );
    } else {
      console.log(
        `  ${dim}.gitignore:${reset} missing ${dim}- add .firecrawl/ to ignore cache${reset}`
      );
    }
    console.log('');
    return;
  }

  // Show error if API calls failed
  if (status.error) {
    console.log(
      `  ${dim}Could not fetch account info: ${status.error}${reset}`
    );
    console.log('');
    if (localStatus.firecrawlDirExists) {
      console.log(
        `  ${dim}.firecrawl:${reset} present ${dim}- ${formatNumber(localStatus.firecrawlFileCount)} sites${reset}`
      );
    } else {
      console.log(
        `  ${dim}.firecrawl:${reset} not found ${dim}- no local cache${reset}`
      );
    }
    if (localStatus.gitignoreExists) {
      const ignoredLabel = localStatus.gitignoreHasFirecrawl ? 'yes' : 'no';
      console.log(
        `  ${dim}.gitignore:${reset} present ${dim}- .firecrawl ignored: ${ignoredLabel}${reset}`
      );
    } else {
      console.log(
        `  ${dim}.gitignore:${reset} missing ${dim}- add .firecrawl/ to ignore cache${reset}`
      );
    }
    console.log('');
    return;
  }

  // Concurrency (parallel jobs limit)
  if (status.concurrency) {
    const { active, max } = status.concurrency;
    console.log(
      `  ${dim}Concurrency:${reset} ${active}/${max} jobs ${dim}(parallel scrape limit)${reset}`
    );
  }

  // Credits
  if (status.credits) {
    const { remaining, plan } = status.credits;
    if (plan > 0) {
      const percent = ((remaining / plan) * 100).toFixed(0);
      console.log(
        `  ${dim}Credits:${reset} ${formatNumber(remaining)} / ${formatNumber(plan)} ${dim}(${percent}% left this cycle)${reset}`
      );
    } else {
      console.log(
        `  ${dim}Credits:${reset} ${formatNumber(remaining)} ${dim}(pay-as-you-go)${reset}`
      );
    }
  }

  if (localStatus.firecrawlDirExists) {
    console.log(
      `  ${dim}.firecrawl:${reset} present ${dim}- ${formatNumber(localStatus.firecrawlFileCount)} sites${reset}`
    );
  } else {
    console.log(
      `  ${dim}.firecrawl:${reset} not found ${dim}- no local cache${reset}`
    );
  }
  if (localStatus.gitignoreExists) {
    const ignoredLabel = localStatus.gitignoreHasFirecrawl ? 'yes' : 'no';
    console.log(
      `  ${dim}.gitignore:${reset} present ${dim}- .firecrawl ignored: ${ignoredLabel}${reset}`
    );
  } else {
    console.log(
      `  ${dim}.gitignore:${reset} missing ${dim}- add .firecrawl/ to ignore cache${reset}`
    );
  }

  if (isSearchFeedbackDisabledLocally()) {
    console.log(
      `  ${dim}Search feedback:${reset} ${red}disabled${reset} ${dim}(FIRECRAWL_NO_SEARCH_FEEDBACK is set)${reset}`
    );
  }

  console.log('');
}
