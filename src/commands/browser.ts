/**
 * Browser command implementation
 * Manages cloud browser sessions via the Firecrawl SDK
 */

import { spawn } from 'child_process';
import { getClient } from '../utils/client';
import {
  saveBrowserSession,
  loadBrowserSession,
  clearBrowserSession,
  getSessionId,
} from '../utils/browser-session';
import { writeOutput } from '../utils/output';

export interface BrowserLaunchOptions {
  ttl?: number;
  ttlInactivity?: number;
  profile?: string;
  saveChanges?: boolean;
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
}

export interface BrowserExecuteOptions {
  code: string;
  language?: 'python' | 'node' | 'bash';
  session?: string;
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
}

export interface BrowserListOptions {
  status?: 'active' | 'destroyed';
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
}

export interface BrowserCloseOptions {
  session?: string;
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
}

export interface BrowserQuickExecuteOptions {
  code: string;
  profile?: string;
  saveChanges?: boolean;
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  json?: boolean;
}

/**
 * Launch a new browser session
 */
export async function handleBrowserLaunch(
  options: BrowserLaunchOptions
): Promise<void> {
  try {
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });

    const args: {
      ttl?: number;
      activityTtl?: number;
      profile?: {
        name: string;
        saveChanges?: boolean;
      };
      integration?: string;
    } = { integration: 'cli' };
    if (options.ttl !== undefined) args.ttl = options.ttl;
    if (options.ttlInactivity !== undefined)
      args.activityTtl = options.ttlInactivity;
    if (options.profile) {
      args.profile = {
        name: options.profile,
        saveChanges: options.saveChanges,
      };
    }

    const data = await app.browser(args as Parameters<typeof app.browser>[0]);

    if (!data.success) {
      console.error('Error:', data.error || 'Unknown error');
      process.exit(1);
    }

    // Save session for future commands
    saveBrowserSession({
      id: data.id!,
      cdpUrl: data.cdpUrl!,
      createdAt: new Date().toISOString(),
    });

    if (options.json) {
      const output = JSON.stringify(data, null, 2);
      writeOutput(output, options.output, !!options.output);
    } else {
      const lines: string[] = [];
      lines.push(`Session ID:    ${data.id}`);
      lines.push(`CDP URL:       ${data.cdpUrl}`);
      if ((data as any).interactiveLiveViewUrl) {
        lines.push(
          `Interactive Live View URL (recommended): ${(data as any).interactiveLiveViewUrl}`
        );
      }
      if (data.liveViewUrl) {
        lines.push(`Live View URL: ${data.liveViewUrl}`);
      }
      writeOutput(lines.join('\n'), options.output, !!options.output);
    }
  } catch (error) {
    console.error(
      'Error:',
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
    process.exit(1);
  }
}

/**
 * Execute a bash command locally with CDP_URL and SESSION_ID env vars.
 * agent-browser reads CDP_URL from the environment automatically.
 */
export function executeBashLocally(
  command: string,
  session: { id: string; cdpUrl: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      env: {
        ...process.env,
        CDP_URL: session.cdpUrl,
        SESSION_ID: session.id,
      },
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

/**
 * Detect if an error indicates an expired or destroyed browser session.
 */
function isSessionExpiredError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  const status = (error as { status?: number }).status;
  if (status === 403 || status === 410 || status === 404) return true;
  return /destroyed|expired|not found|gone|session.*closed/i.test(msg);
}

/**
 * Execute code in a browser session
 */
export async function handleBrowserExecute(
  options: BrowserExecuteOptions
): Promise<void> {
  try {
    const sessionId = getSessionId(options.session);
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });

    const data = await app.browserExecute(sessionId, {
      code: options.code,
      language: options.language || 'bash',
    });

    if (!data.success) {
      console.error('Error:', data.error || 'Unknown error');
      process.exit(1);
    }

    if (data.error) {
      process.stderr.write(`Code error: ${data.error}\n`);
    }

    if (options.json) {
      const output = JSON.stringify(data, null, 2);
      writeOutput(output, options.output, !!options.output);
    } else {
      const result = data.stdout || data.result || '';
      if (result) {
        writeOutput(result.trimEnd(), options.output, !!options.output);
      }
    }
  } catch (error) {
    if (isSessionExpiredError(error)) {
      const sessionId =
        options.session || loadBrowserSession()?.id || 'unknown';
      console.error(
        `Error: Session ${sessionId} has expired or been destroyed.\n` +
          'The session may have exceeded its TTL or been closed.\n' +
          'Start a new session with: firecrawl browser launch'
      );
      const stored = loadBrowserSession();
      if (stored && !options.session) {
        clearBrowserSession();
      }
    } else {
      console.error(
        'Error:',
        error instanceof Error ? error.message : 'Unknown error occurred'
      );
    }
    process.exit(1);
  }
}

/**
 * List browser sessions
 */
export async function handleBrowserList(
  options: BrowserListOptions
): Promise<void> {
  try {
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });

    const data = await app.listBrowsers(
      options.status ? { status: options.status } : undefined
    );

    if (!data.success) {
      console.error('Error:', data.error || 'Unknown error');
      process.exit(1);
    }

    const sessions = data.sessions || [];

    if (options.json) {
      const output = JSON.stringify(data, null, 2);
      writeOutput(output, options.output, !!options.output);
    } else {
      if (sessions.length === 0) {
        writeOutput(
          'No active browser sessions.',
          options.output,
          !!options.output
        );
      } else {
        const lines: string[] = [];
        for (const s of sessions) {
          const age = s.createdAt
            ? `created ${new Date(s.createdAt).toLocaleString()}`
            : '';
          lines.push(`${s.id}  ${s.status}  ${age}`);
        }
        writeOutput(lines.join('\n'), options.output, !!options.output);
      }
    }
  } catch (error) {
    console.error(
      'Error:',
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
    process.exit(1);
  }
}

/**
 * Shorthand: auto-launch a session if needed, then execute an agent-browser command.
 * Enables `firecrawl browser "open example.com"` without a separate launch step.
 */
export async function handleBrowserQuickExecute(
  options: BrowserQuickExecuteOptions
): Promise<void> {
  async function launchNewSession(): Promise<void> {
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });

    const launchArgs: {
      profile?: {
        name: string;
        saveChanges?: boolean;
      };
      integration?: string;
    } = { integration: 'cli' };
    if (options.profile) {
      launchArgs.profile = {
        name: options.profile,
        saveChanges: options.saveChanges,
      };
    }

    const data = await app.browser(
      launchArgs as Parameters<typeof app.browser>[0]
    );

    if (!data.success) {
      console.error('Error:', data.error || 'Failed to launch session');
      process.exit(1);
    }

    saveBrowserSession({
      id: data.id!,
      cdpUrl: data.cdpUrl!,
      createdAt: new Date().toISOString(),
    });

    console.error(`Session launched: ${data.id}`);
  }

  // Auto-launch if no active session
  if (!loadBrowserSession()) {
    try {
      await launchNewSession();
    } catch (error) {
      console.error(
        'Error:',
        error instanceof Error ? error.message : 'Failed to launch session'
      );
      process.exit(1);
    }
  }

  // Auto-prefix agent-browser if needed
  let finalCode = options.code;
  if (!finalCode.startsWith('agent-browser')) {
    finalCode = `agent-browser ${finalCode}`;
  }

  const executeOptions = {
    code: finalCode,
    language: 'bash' as const,
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
    output: options.output,
    json: options.json,
  };

  // Try executing; if the cached session is stale, launch a new one and retry
  try {
    const sessionId = getSessionId();
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });

    const data = await app.browserExecute(sessionId, {
      code: executeOptions.code,
      language: executeOptions.language,
    });

    if (!data.success) {
      console.error('Error:', data.error || 'Unknown error');
      process.exit(1);
    }

    if (data.error) {
      process.stderr.write(`Code error: ${data.error}\n`);
    }

    if (options.json) {
      const output = JSON.stringify(data, null, 2);
      writeOutput(output, options.output, !!options.output);
    } else {
      const result = data.stdout || data.result || '';
      if (result) {
        writeOutput(result.trimEnd(), options.output, !!options.output);
      }
    }
  } catch (error) {
    if (isSessionExpiredError(error)) {
      console.error('Cached session expired, launching a new one...');
      clearBrowserSession();

      try {
        await launchNewSession();
      } catch (launchError) {
        console.error(
          'Error:',
          launchError instanceof Error
            ? launchError.message
            : 'Failed to launch session'
        );
        process.exit(1);
      }

      // Retry with the new session
      await handleBrowserExecute(executeOptions);
    } else {
      console.error(
        'Error:',
        error instanceof Error ? error.message : 'Unknown error occurred'
      );
      process.exit(1);
    }
  }
}

/**
 * Close a browser session
 */
export async function handleBrowserClose(
  options: BrowserCloseOptions
): Promise<void> {
  try {
    const sessionId = getSessionId(options.session);
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });

    const data = await app.deleteBrowser(sessionId);

    if (!data.success) {
      console.error('Error:', data.error || 'Unknown error');
      process.exit(1);
    }

    // Clear stored session
    const stored = loadBrowserSession();
    if (stored && stored.id === sessionId) {
      clearBrowserSession();
    }

    console.log(`Session closed (${sessionId})`);

    if (options.json) {
      const output = JSON.stringify({ success: true, id: sessionId }, null, 2);
      writeOutput(output, options.output, !!options.output);
    }
  } catch (error) {
    console.error(
      'Error:',
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
    process.exit(1);
  }
}
