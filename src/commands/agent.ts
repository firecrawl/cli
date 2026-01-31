/**
 * Agent command implementation
 */

import type {
  AgentOptions,
  AgentResult,
  AgentStatusResult,
} from '../types/agent';
import { getClient } from '../utils/client';
import { isJobId } from '../utils/job';
import { writeOutput } from '../utils/output';
import { createSpinner } from '../utils/spinner';
import { readFileSync } from 'fs';

/**
 * Extract detailed error message from API errors
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const anyError = error as any;

    // Handle Firecrawl SDK errors with details array
    if (anyError.details && Array.isArray(anyError.details)) {
      const messages = anyError.details
        .map((d: any) => d.message || JSON.stringify(d))
        .join('; ');
      return messages || error.message;
    }

    // Check for response data in the error (common in axios/fetch errors)
    if (anyError.response?.data?.error) {
      return anyError.response.data.error;
    }
    if (anyError.response?.data?.message) {
      return anyError.response.data.message;
    }
    if (anyError.response?.data) {
      return JSON.stringify(anyError.response.data);
    }

    return error.message;
  }
  return 'Unknown error occurred';
}

/**
 * Load schema from file
 */
function loadSchemaFromFile(filePath: string): Record<string, unknown> {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Schema file not found: ${filePath}`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in schema file: ${filePath}`);
    }
    throw error;
  }
}

/**
 * Execute agent status check (with optional wait/polling)
 */
async function checkAgentStatus(
  jobId: string,
  options: AgentOptions
): Promise<AgentStatusResult> {
  const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });

  // If not waiting, just return current status
  if (!options.wait) {
    try {
      const status = await app.getAgentStatus(jobId);
      return {
        success: status.success,
        data: {
          id: jobId,
          status: status.status,
          data: status.data,
          creditsUsed: status.creditsUsed,
          expiresAt: status.expiresAt,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: extractErrorMessage(error),
      };
    }
  }

  // Wait mode: poll until completion
  const spinner = createSpinner(`Checking agent status...`);
  spinner.start();

  // Handle Ctrl+C gracefully
  const handleInterrupt = () => {
    spinner.stop();
    process.stderr.write('\n\nInterrupted. Agent may still be running.\n');
    process.stderr.write(`Check status with: firecrawl agent ${jobId}\n\n`);
    process.exit(0);
  };
  process.on('SIGINT', handleInterrupt);

  const pollMs = options.pollInterval ? options.pollInterval * 1000 : 5000;
  const startTime = Date.now();
  const timeoutMs = options.timeout ? options.timeout * 1000 : undefined;

  try {
    // Check initial status
    let agentStatus = await app.getAgentStatus(jobId);
    spinner.update(`Agent ${agentStatus.status}... (Job ID: ${jobId})`);

    while (true) {
      if (agentStatus.status === 'completed') {
        spinner.succeed('Agent completed');
        return {
          success: agentStatus.success,
          data: {
            id: jobId,
            status: agentStatus.status,
            data: agentStatus.data,
            creditsUsed: agentStatus.creditsUsed,
            expiresAt: agentStatus.expiresAt,
          },
        };
      }

      if (agentStatus.status === 'failed') {
        spinner.fail('Agent failed');
        return {
          success: false,
          data: {
            id: jobId,
            status: agentStatus.status,
            data: agentStatus.data,
            creditsUsed: agentStatus.creditsUsed,
            expiresAt: agentStatus.expiresAt,
          },
          error: agentStatus.error,
        };
      }

      // Check timeout
      if (timeoutMs && Date.now() - startTime > timeoutMs) {
        spinner.fail(`Timeout after ${options.timeout}s`);
        return {
          success: false,
          error: `Timeout after ${options.timeout} seconds. Agent still processing.`,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
      agentStatus = await app.getAgentStatus(jobId);
      spinner.update(`Agent ${agentStatus.status}... (Job ID: ${jobId})`);
    }
  } catch (error) {
    spinner.fail('Failed to check agent status');
    return {
      success: false,
      error: extractErrorMessage(error),
    };
  } finally {
    process.removeListener('SIGINT', handleInterrupt);
  }
}

/**
 * Execute agent command
 */
export async function executeAgent(
  options: AgentOptions
): Promise<AgentResult | AgentStatusResult> {
  try {
    const app = getClient({ apiKey: options.apiKey, apiUrl: options.apiUrl });
    const { prompt, status, wait, pollInterval, timeout } = options;

    // If status flag is set or input looks like a job ID, check status
    if (status || isJobId(prompt)) {
      return await checkAgentStatus(prompt, options);
    }

    // Load schema from file if specified
    let schema: Record<string, unknown> | undefined = options.schema as
      | Record<string, unknown>
      | undefined;
    if (options.schemaFile) {
      schema = loadSchemaFromFile(options.schemaFile);
    }

    // Build agent options
    const agentParams: {
      prompt: string;
      urls?: string[];
      schema?: Record<string, unknown>;
      model?: 'spark-1-pro' | 'spark-1-mini';
      maxCredits?: number;
      pollInterval?: number;
      timeout?: number;
    } = {
      prompt,
    };

    if (options.urls && options.urls.length > 0) {
      agentParams.urls = options.urls;
    }
    if (schema) {
      agentParams.schema = schema;
    }
    if (options.model) {
      agentParams.model = options.model as 'spark-1-pro' | 'spark-1-mini';
    }
    if (options.maxCredits !== undefined) {
      agentParams.maxCredits = options.maxCredits;
    }

    // If wait mode, use polling with spinner
    if (wait) {
      const spinner = createSpinner('Starting agent...');
      spinner.start();

      // Start agent first
      let response;
      try {
        response = await app.startAgent(agentParams);
      } catch (error) {
        spinner.fail('Failed to start agent');
        return {
          success: false,
          error: extractErrorMessage(error),
        };
      }
      const jobId = response.id;

      // Handle Ctrl+C gracefully
      const handleInterrupt = () => {
        spinner.stop();
        process.stderr.write('\n\nInterrupted. Agent is still running.\n');
        process.stderr.write(`Check status with: firecrawl agent ${jobId}\n\n`);
        process.exit(0);
      };
      process.on('SIGINT', handleInterrupt);

      spinner.update(`Agent running... (Job ID: ${jobId})`);

      // Poll for status
      const pollMs = pollInterval ? pollInterval * 1000 : 5000;
      const startTime = Date.now();
      const timeoutMs = timeout ? timeout * 1000 : undefined;

      try {
        while (true) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));

          const agentStatus = await app.getAgentStatus(jobId);

          if (agentStatus.status === 'completed') {
            process.removeListener('SIGINT', handleInterrupt);
            spinner.succeed('Agent completed');
            return {
              success: agentStatus.success,
              data: {
                id: jobId,
                status: agentStatus.status,
                data: agentStatus.data,
                creditsUsed: agentStatus.creditsUsed,
                expiresAt: agentStatus.expiresAt,
              },
            };
          }

          if (agentStatus.status === 'failed') {
            process.removeListener('SIGINT', handleInterrupt);
            spinner.fail('Agent failed');
            return {
              success: false,
              data: {
                id: jobId,
                status: agentStatus.status,
                data: agentStatus.data,
                creditsUsed: agentStatus.creditsUsed,
                expiresAt: agentStatus.expiresAt,
              },
              error: agentStatus.error,
            };
          }

          // Check timeout
          if (timeoutMs && Date.now() - startTime > timeoutMs) {
            process.removeListener('SIGINT', handleInterrupt);
            spinner.fail(`Timeout after ${timeout}s (Job ID: ${jobId})`);
            return {
              success: false,
              error: `Timeout after ${timeout} seconds. Agent still processing. Job ID: ${jobId}`,
            };
          }
        }
      } finally {
        process.removeListener('SIGINT', handleInterrupt);
      }
    }

    // Otherwise, start agent and return job ID
    const spinner = createSpinner('Starting agent...');
    spinner.start();

    let response;
    try {
      response = await app.startAgent(agentParams);
    } catch (error) {
      spinner.fail('Failed to start agent');
      return {
        success: false,
        error: extractErrorMessage(error),
      };
    }

    spinner.succeed(`Agent started (Job ID: ${response.id})`);

    return {
      success: response.success,
      data: {
        jobId: response.id,
        status: 'processing',
      },
    };
  } catch (error) {
    return {
      success: false,
      error: extractErrorMessage(error),
    };
  }
}

/**
 * Format agent status in human-readable way
 */
function formatAgentStatus(data: AgentStatusResult['data']): string {
  if (!data) return '';

  const lines: string[] = [];
  lines.push(`Job ID: ${data.id}`);
  lines.push(`Status: ${data.status}`);

  if (data.creditsUsed !== undefined) {
    lines.push(`Credits Used: ${data.creditsUsed}`);
  }

  if (data.expiresAt) {
    const expiresDate = new Date(data.expiresAt);
    lines.push(
      `Expires: ${expiresDate.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}`
    );
  }

  if (data.data) {
    lines.push('');
    lines.push('Result:');
    lines.push(JSON.stringify(data.data, null, 2));
  }

  return lines.join('\n') + '\n';
}

/**
 * Handle agent command output
 */
export async function handleAgentCommand(options: AgentOptions): Promise<void> {
  const result = await executeAgent(options);

  if (!result.success) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  // Handle status result (completed agent job with data)
  if ('data' in result && result.data && 'data' in result.data) {
    const statusResult = result as AgentStatusResult;
    if (statusResult.data) {
      let outputContent: string;

      if (options.json) {
        // JSON format
        outputContent = options.pretty
          ? JSON.stringify({ success: true, ...statusResult.data }, null, 2)
          : JSON.stringify({ success: true, ...statusResult.data });
      } else {
        // Human-readable format
        outputContent = formatAgentStatus(statusResult.data);
      }

      writeOutput(outputContent, options.output, !!options.output);
      return;
    }
  }

  // Handle agent start result (job ID)
  const agentResult = result as AgentResult;
  if (!agentResult.data) {
    return;
  }

  let outputContent: string;

  if ('jobId' in agentResult.data) {
    const jobData = {
      jobId: agentResult.data.jobId,
      status: agentResult.data.status,
    };

    outputContent = options.pretty
      ? JSON.stringify({ success: true, data: jobData }, null, 2)
      : JSON.stringify({ success: true, data: jobData });
  } else {
    outputContent = options.pretty
      ? JSON.stringify(agentResult.data, null, 2)
      : JSON.stringify(agentResult.data);
  }

  writeOutput(outputContent, options.output, !!options.output);
}
