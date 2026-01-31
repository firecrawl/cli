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
 * Detect AI coding agents/IDEs that might be using the CLI
 * Returns all detected agent names since users may have multiple installed
 */
function detectCodingAgents(): string[] {
  try {
    const agents: string[] = [];
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    // Environment variable detection
    // Based on documented env vars from official sources
    const envDetections: Array<{
      name: string;
      envVars: string[];
    }> = [
      // Aider: Well-documented env vars - https://aider.chat/docs/config/options.html
      {
        name: 'aider',
        envVars: ['AIDER_MODEL', 'AIDER_WEAK_MODEL', 'AIDER_EDITOR_MODEL'],
      },
      // Codex (OpenAI): Uses CODEX_HOME for config - https://developers.openai.com/codex/config-advanced/
      {
        name: 'codex',
        envVars: ['CODEX_HOME'],
      },
      // OpenCode: Documented env vars - https://opencode.ai/docs/config/
      {
        name: 'opencode',
        envVars: [
          'OPENCODE_CONFIG',
          'OPENCODE_CONFIG_DIR',
          'OPENCODE_CONFIG_CONTENT',
        ],
      },
      // VS Code: Standard VS Code env vars set in integrated terminal
      {
        name: 'vscode',
        envVars: [
          'VSCODE_PID',
          'VSCODE_CWD',
          'VSCODE_IPC_HOOK',
          'VSCODE_GIT_IPC_HANDLE',
        ],
      },
      // Zed: Terminal indicator
      {
        name: 'zed',
        envVars: ['ZED_TERM'],
      },
      // Gemini CLI: Google's CLI - https://geminicli.com/docs/get-started/configuration/
      {
        name: 'gemini-cli',
        envVars: [
          'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
          'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
        ],
      },
    ];

    // Check TERM_PROGRAM for terminal-based detection
    // IDEs often set this when spawning integrated terminals
    const termProgram = process.env.TERM_PROGRAM?.toLowerCase();
    if (termProgram) {
      if (termProgram.includes('cursor')) {
        agents.push('cursor');
      } else if (termProgram.includes('windsurf')) {
        agents.push('windsurf');
      } else if (termProgram.includes('vscode') || termProgram === 'vscode') {
        agents.push('vscode');
      } else if (termProgram.includes('zed')) {
        agents.push('zed');
      }
    }

    // Check specific environment variables
    for (const detection of envDetections) {
      // Skip if already detected via TERM_PROGRAM
      if (agents.includes(detection.name)) continue;

      const hasEnvVar = detection.envVars.some((envVar) => process.env[envVar]);
      if (hasEnvVar) {
        agents.push(detection.name);
      }
    }

    // Config directory detection (check home directory)
    const homeDir = os.homedir();
    const cwd = process.cwd();

    // Config directory detection
    // Based on official documentation for each tool
    const configDirDetections: Array<{
      name: string;
      dirs: string[];
      // If set, check for this file/subdirectory for a stronger signal
      indicator?: string;
      // Check home directory config path (some tools use ~/.config/toolname)
      homeConfigPath?: string;
    }> = [
      // Cursor: Uses .cursor/ directory - https://docs.cursor.com
      {
        name: 'cursor',
        dirs: ['.cursor'],
      },
      // Claude Code: Uses .claude/ with settings files - https://docs.anthropic.com/claude-code
      // Strong indicator: .claude/settings.json or .claude/settings.local.json
      {
        name: 'claude-code',
        dirs: ['.claude'],
        indicator: 'settings.json',
      },
      // VS Code: Uses .vscode/ for workspace settings
      {
        name: 'vscode',
        dirs: ['.vscode'],
      },
      // GitHub Copilot: VS Code extension, check for copilot config
      {
        name: 'github-copilot',
        dirs: ['.github'],
        indicator: 'copilot-instructions.md',
      },
      // OpenCode: Uses .opencode/ in project, ~/.config/opencode/ globally
      // https://opencode.ai/docs/config/
      {
        name: 'opencode',
        dirs: ['.opencode'],
        homeConfigPath: '.config/opencode',
      },
      // Codex (OpenAI): Uses ~/.codex/ for config
      // https://developers.openai.com/codex/config-advanced/
      {
        name: 'codex',
        dirs: ['.codex'],
      },
      // Continue: Uses ~/.continue/ for config
      // https://docs.continue.dev/setup/configuration
      {
        name: 'continue',
        dirs: ['.continue'],
        indicator: 'config.yaml',
      },
      // Aider: Uses .aider.conf.yml config files (not a directory)
      // https://aider.chat/docs/config/options.html
      {
        name: 'aider',
        dirs: ['.aider.conf.yml'],
      },
      // Windsurf: VS Code fork, may use .windsurf/
      {
        name: 'windsurf',
        dirs: ['.windsurf'],
      },
      // Cline: VS Code extension, stores in VS Code settings
      // May have .cline/ for project settings
      {
        name: 'cline',
        dirs: ['.cline'],
      },
      // Roo Code: VS Code extension, may have .roo/ or uses VS Code settings
      {
        name: 'roo-code',
        dirs: ['.roo'],
      },
      // Gemini CLI: Google's CLI uses ~/.gemini/ - https://geminicli.com/docs/get-started/configuration/
      {
        name: 'gemini-cli',
        dirs: ['.gemini'],
        indicator: 'settings.json',
      },
      // Antigravity: Google's AI dev environment uses .antigravity config file
      {
        name: 'antigravity',
        dirs: ['.antigravity'],
      },
    ];

    for (const detection of configDirDetections) {
      // Skip if already detected
      if (agents.includes(detection.name)) continue;

      let found = false;

      // Check homeConfigPath first (e.g., ~/.config/opencode/)
      if (detection.homeConfigPath) {
        try {
          const configPath = path.join(homeDir, detection.homeConfigPath);
          if (fs.existsSync(configPath)) {
            found = true;
          }
        } catch {
          // Ignore permission errors
        }
      }

      // Check standard directories
      if (!found) {
        for (const dir of detection.dirs) {
          // Check in current working directory (project-level config)
          const cwdPath = path.join(cwd, dir);
          // Check in home directory (global config)
          const homePath = path.join(homeDir, dir);

          try {
            // If indicator is specified, check for that file/subdir for a stronger signal
            if (detection.indicator) {
              const cwdIndicator = path.join(cwdPath, detection.indicator);
              const homeIndicator = path.join(homePath, detection.indicator);
              if (fs.existsSync(cwdIndicator) || fs.existsSync(homeIndicator)) {
                found = true;
                break;
              }
            }

            // Check if the directory/file itself exists
            if (fs.existsSync(cwdPath) || fs.existsSync(homePath)) {
              found = true;
              break;
            }
          } catch {
            // Ignore permission errors
          }
        }
      }

      if (found) {
        agents.push(detection.name);
      }
    }

    return agents;
  } catch (error) {
    console.error('Error detecting coding agents:', error);
    return [];
  }
}

/**
 * Check if telemetry is disabled via environment variable
 */
function isTelemetryDisabled(): boolean {
  const noTelemetry = process.env.FIRECRAWL_NO_TELEMETRY;
  return noTelemetry === '1' || noTelemetry === 'true';
}

/**
 * Get CLI metadata for telemetry
 * Returns null if telemetry is disabled
 */
function getCliMetadata(): {
  cli_version: string;
  os_platform: string;
  node_version: string;
  detected_agents: string;
} | null {
  // Check if telemetry is disabled
  if (isTelemetryDisabled()) {
    return null;
  }

  // Dynamic import to avoid circular dependencies
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const packageJson = require('../../package.json');

  // Detect coding agents
  const agents = detectCodingAgents();

  return {
    cli_version: packageJson.version || 'unknown',
    os_platform: process.platform,
    node_version: process.version,
    detected_agents: agents.join(',') || 'unknown',
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
  // Returns null if telemetry is disabled via FIRECRAWL_NO_TELEMETRY
  const metadata = getCliMetadata();

  let loginUrl: string;
  if (metadata) {
    // Encode telemetry as base64 JSON to make it less explicit in the URL
    const telemetryData = Buffer.from(JSON.stringify(metadata)).toString(
      'base64url'
    );
    loginUrl = `${webUrl}/cli-auth?code_challenge=${codeChallenge}&t=${telemetryData}#session_id=${sessionId}`;
  } else {
    // Telemetry disabled - don't send metadata
    loginUrl = `${webUrl}/cli-auth?code_challenge=${codeChallenge}#session_id=${sessionId}`;
  }

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
 * For custom API URLs (local development), API key is optional
 */
async function manualLogin(
  apiUrl: string = DEFAULT_API_URL
): Promise<{ apiKey: string; apiUrl: string }> {
  const isCustomUrl = apiUrl !== DEFAULT_API_URL;

  console.log('');

  if (isCustomUrl) {
    const apiKey = await promptInput(
      'Enter your API key (press Enter to skip): '
    );
    return {
      apiKey: apiKey.trim(),
      apiUrl,
    };
  }

  const apiKey = await promptInput('Enter your Firecrawl API key: ');

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('API key cannot be empty');
  }

  if (!apiKey.startsWith('fc-')) {
    throw new Error('Invalid API key format. API keys should start with "fc-"');
  }

  return {
    apiKey: apiKey.trim(),
    apiUrl,
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
  webUrl?: string,
  apiUrl?: string
): Promise<{ apiKey: string; apiUrl: string; teamName?: string }> {
  const effectiveApiUrl = apiUrl || DEFAULT_API_URL;
  const isCustomUrl = effectiveApiUrl !== DEFAULT_API_URL;

  // First check if env var is set
  const envResult = envVarLogin();
  if (envResult) {
    printBanner();
    console.log('✓ Using FIRECRAWL_API_KEY from environment variable\n');
    return envResult;
  }

  printBanner();

  // For custom URLs (local development), skip browser auth option
  if (isCustomUrl) {
    console.log(`Configuring CLI for custom API: ${effectiveApiUrl}\n`);
    return manualLogin(effectiveApiUrl);
  }

  console.log(
    'Welcome! To get started, authenticate with your Firecrawl account.\n'
  );
  console.log(
    '  \x1b[1m1.\x1b[0m Login with browser \x1b[2m(recommended)\x1b[0m'
  );
  console.log('  \x1b[1m2.\x1b[0m Enter API key manually');
  console.log('');
  printEnvHint();
  printTelemetryNotice();

  const choice = await promptInput('Enter choice [1/2]: ');

  if (choice === '2' || choice.toLowerCase() === 'manual') {
    return manualLogin(effectiveApiUrl);
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
 * Print telemetry notice
 */
function printTelemetryNotice(): void {
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  if (isTelemetryDisabled()) {
    console.log(`${dim}Telemetry disabled${reset}\n`);
  } else {
    console.log(
      `${dim}Anonymous telemetry (OS, CLI version, dev tools) collected to improve the CLI.${reset}`
    );
    console.log(`${dim}Disable with FIRECRAWL_NO_TELEMETRY=1${reset}\n`);
  }
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
