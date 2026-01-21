/**
 * Authentication utilities
 * Provides automatic authentication prompts when credentials are missing
 */

import * as readline from 'readline';
import * as crypto from 'crypto';
import {
  loadCredentials,
  saveCredentials,
  getConfigDirectoryPath,
} from './credentials';
import { updateConfig, getApiKey } from './config';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';
const WEB_URL = 'https://firecrawl.dev';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 2000; // 2 seconds

/**
 * Prompt for input
 */
function promptInput(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Open URL in the default browser
 */
async function openBrowser(url: string): Promise<void> {
  const { exec } = await import('child_process');
  const platform = process.platform;

  let command: string;
  switch (platform) {
    case 'darwin':
      command = `open "${url}"`;
      break;
    case 'win32':
      command = `start "" "${url}"`;
      break;
    default:
      command = `xdg-open "${url}"`;
  }

  return new Promise((resolve, reject) => {
    exec(command, (error: Error | null) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Generate a secure random session ID
 */
function generateSessionId(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Generate a PKCE code verifier (random string, base64url encoded)
 */
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate a PKCE code challenge from the verifier (SHA256, base64url encoded)
 */
function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Poll the server for authentication status using PKCE verification
 * Uses POST to send the code_verifier securely (not in URL)
 */
async function pollAuthStatus(
  sessionId: string,
  codeVerifier: string,
  webUrl: string
): Promise<{ apiKey: string; apiUrl?: string; teamName?: string } | null> {
  const statusUrl = `${webUrl}/api/auth/cli/status`;

  try {
    const response = await fetch(statusUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session_id: sessionId,
        code_verifier: codeVerifier,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (data.status === 'complete' && data.apiKey) {
      return {
        apiKey: data.apiKey,
        apiUrl: data.apiUrl || DEFAULT_API_URL,
        teamName: data.teamName || undefined,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Wait for authentication with polling
 */
async function waitForAuth(
  sessionId: string,
  codeVerifier: string,
  webUrl: string,
  timeoutMs: number = AUTH_TIMEOUT_MS
): Promise<{ apiKey: string; apiUrl?: string; teamName?: string }> {
  const startTime = Date.now();
  let dots = 0;

  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error('Authentication timed out. Please try again.'));
        return;
      }

      process.stdout.write(
        `\rWaiting for browser authentication${'.'.repeat(dots % 4).padEnd(3)} `
      );
      dots++;

      const result = await pollAuthStatus(sessionId, codeVerifier, webUrl);
      if (result) {
        process.stdout.write('\r' + ' '.repeat(50) + '\r');
        resolve(result);
        return;
      }

      setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();
  });
}

/**
 * Get CLI metadata for telemetry
 */
function getCliMetadata(): {
  cli_version: string;
  os_platform: string;
  node_version: string;
} {
  // Dynamic import to avoid circular dependencies
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const packageJson = require('../../package.json');
  return {
    cli_version: packageJson.version || 'unknown',
    os_platform: process.platform,
    node_version: process.version,
  };
}

/**
 * Perform browser-based login using PKCE flow
 *
 * Security: Uses PKCE (Proof Key for Code Exchange) pattern:
 * - session_id is passed in URL fragment (not sent to server in HTTP request)
 * - code_challenge (hash of verifier) is in query string (safe to expose)
 * - code_verifier is kept secret and only sent via POST when exchanging for token
 */
async function browserLogin(
  webUrl: string = WEB_URL
): Promise<{ apiKey: string; apiUrl: string; teamName?: string }> {
  const sessionId = generateSessionId();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Get CLI metadata for telemetry (non-sensitive)
  const metadata = getCliMetadata();
  const telemetryParams = new URLSearchParams({
    cli_version: metadata.cli_version,
    os_platform: metadata.os_platform,
    node_version: metadata.node_version,
  }).toString();

  // code_challenge and telemetry in query (safe - not sensitive)
  // session_id in fragment (not sent to server, read by JS only)
  const loginUrl = `${webUrl}/cli-auth?code_challenge=${codeChallenge}&${telemetryParams}#session_id=${sessionId}`;

  console.log('\nOpening browser for authentication...');
  console.log(`If the browser doesn't open, visit: ${loginUrl}\n`);

  try {
    await openBrowser(loginUrl);
  } catch {
    console.log(
      'Could not open browser automatically. Please visit the URL above.'
    );
  }

  const result = await waitForAuth(sessionId, codeVerifier, webUrl);
  return {
    apiKey: result.apiKey,
    apiUrl: result.apiUrl || DEFAULT_API_URL,
    teamName: result.teamName,
  };
}

/**
 * Perform manual API key login
 */
async function manualLogin(): Promise<{ apiKey: string; apiUrl: string }> {
  console.log('');
  const apiKey = await promptInput('Enter your Firecrawl API key: ');

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('API key cannot be empty');
  }

  if (!apiKey.startsWith('fc-')) {
    throw new Error('Invalid API key format. API keys should start with "fc-"');
  }

  return {
    apiKey: apiKey.trim(),
    apiUrl: DEFAULT_API_URL,
  };
}

/**
 * Use environment variable for authentication
 */
function envVarLogin(): { apiKey: string; apiUrl: string } | null {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (apiKey && apiKey.length > 0) {
    return {
      apiKey,
      apiUrl: process.env.FIRECRAWL_API_URL || DEFAULT_API_URL,
    };
  }
  return null;
}

/**
 * Print the Firecrawl CLI banner
 */
function printBanner(): void {
  const orange = '\x1b[38;5;208m';
  const reset = '\x1b[0m';
  const dim = '\x1b[2m';
  const bold = '\x1b[1m';

  // Get version from package.json
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const packageJson = require('../../package.json');
  const version = packageJson.version || 'unknown';

  console.log('');
  console.log(
    `  ${orange}🔥 ${bold}firecrawl${reset} ${dim}cli${reset} ${dim}v${version}${reset}`
  );
  console.log(`  ${dim}Turn websites into LLM-ready data${reset}`);
  console.log('');
}

/**
 * Interactive login flow - prompts user to choose method
 */
async function interactiveLogin(
  webUrl?: string
): Promise<{ apiKey: string; apiUrl: string; teamName?: string }> {
  // First check if env var is set
  const envResult = envVarLogin();
  if (envResult) {
    printBanner();
    console.log('✓ Using FIRECRAWL_API_KEY from environment variable\n');
    return envResult;
  }

  printBanner();
  console.log(
    'Welcome! To get started, authenticate with your Firecrawl account.\n'
  );
  console.log(
    '  \x1b[1m1.\x1b[0m Login with browser \x1b[2m(recommended)\x1b[0m'
  );
  console.log('  \x1b[1m2.\x1b[0m Enter API key manually');
  console.log('');
  printEnvHint();

  const choice = await promptInput('Enter choice [1/2]: ');

  if (choice === '2' || choice.toLowerCase() === 'manual') {
    return manualLogin();
  } else {
    return browserLogin(webUrl);
  }
}

/**
 * Print hint about environment variable
 */
function printEnvHint(): void {
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  console.log(
    `${dim}Tip: You can also set FIRECRAWL_API_KEY environment variable${reset}\n`
  );
}

/**
 * Export banner for use in other places
 */
export { printBanner };

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  const apiKey = getApiKey();
  return !!apiKey && apiKey.length > 0;
}

/**
 * Ensure user is authenticated before running a command
 * If not authenticated, prompts for login
 * Returns the API key
 */
export async function ensureAuthenticated(): Promise<string> {
  // Check if we already have credentials
  const existingKey = getApiKey();
  if (existingKey) {
    return existingKey;
  }

  // No credentials found - prompt for login
  try {
    const result = await interactiveLogin();

    // Save credentials
    saveCredentials({
      apiKey: result.apiKey,
      apiUrl: result.apiUrl,
    });

    // Update global config
    updateConfig({
      apiKey: result.apiKey,
      apiUrl: result.apiUrl,
    });

    console.log('\n✓ Login successful!');
    if (result.teamName) {
      console.log(`  Team: ${result.teamName}`);
    }

    return result.apiKey;
  } catch (error) {
    console.error(
      '\nAuthentication failed:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    process.exit(1);
  }
}

/**
 * Export for direct login command usage
 */
export { browserLogin, manualLogin, interactiveLogin };
