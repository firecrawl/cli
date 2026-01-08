/**
 * Credit usage command implementation
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfig, updateConfig, validateConfig } from '../utils/config';

export interface CreditUsageResult {
  success: boolean;
  data?: {
    remainingCredits: number;
    planCredits: number;
    billingPeriodStart: string | null;
    billingPeriodEnd: string | null;
  };
  error?: string;
}

export interface CreditUsageOptions {
  /** API key for Firecrawl */
  apiKey?: string;
  /** Output file path */
  output?: string;
  /** Output as JSON format */
  json?: boolean;
  /** Pretty print JSON output */
  pretty?: boolean;
}

/**
 * Execute the credit usage command
 */
export async function executeCreditUsage(
  options: CreditUsageOptions = {}
): Promise<CreditUsageResult> {
  try {
    // Update global config if API key is provided via options
    if (options.apiKey) {
      updateConfig({ apiKey: options.apiKey });
    }

    // Get config and validate API key
    const config = getConfig();
    validateConfig(config.apiKey);

    const apiUrl = config.apiUrl || 'https://api.firecrawl.dev';
    const apiKey = config.apiKey!;

    // Make the API call to /v2/team/credit-usage
    const url = `${apiUrl.replace(/\/$/, '')}/v2/team/credit-usage`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        errorData.error || `HTTP ${response.status}: ${response.statusText}`
      );
    }

    const result = await response.json();

    // Extract data from response (handle both { data: {...} } and direct data formats)
    const data = result.data || result;

    return {
      success: true,
      data: {
        remainingCredits: data.remainingCredits,
        planCredits: data.planCredits,
        billingPeriodStart: data.billingPeriodStart,
        billingPeriodEnd: data.billingPeriodEnd,
      },
    };
  } catch (error: any) {
    // Handle different error formats
    const errorMessage =
      error?.message || error?.toString() || 'Unknown error occurred';

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Format credit usage data in a human-readable way
 */
function formatReadable(data: CreditUsageResult['data']): string {
  if (!data) return '';

  // Format credits with thousand separators
  const formatNumber = (num: number): string => {
    return num.toLocaleString('en-US');
  };

  const lines: string[] = [];

  // Main credit info
  lines.push(`Remaining Credits: ${formatNumber(data.remainingCredits)}`);

  if (data.planCredits > 0) {
    const usedCredits = data.planCredits - data.remainingCredits;
    const usagePercent = ((usedCredits / data.planCredits) * 100).toFixed(1);
    lines.push(`Plan Credits: ${formatNumber(data.planCredits)}`);
    lines.push(`Used Credits: ${formatNumber(usedCredits)} (${usagePercent}%)`);
  }

  // Format billing period if available
  if (data.billingPeriodStart && data.billingPeriodEnd) {
    const startDate = new Date(data.billingPeriodStart);
    const endDate = new Date(data.billingPeriodEnd);
    const formatDate = (date: Date): string => {
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    };
    lines.push('');
    lines.push(
      `Billing Period: ${formatDate(startDate)} - ${formatDate(endDate)}`
    );
  }

  return lines.join('\n') + '\n';
}

/**
 * Handle credit usage command output
 */
export async function handleCreditUsageCommand(
  options: CreditUsageOptions = {}
): Promise<void> {
  const result = await executeCreditUsage(options);

  if (!result.success) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  if (!result.data) {
    return;
  }

  let outputContent: string;

  // Use JSON format if --json flag is set
  if (options.json) {
    try {
      outputContent = options.pretty
        ? JSON.stringify({ success: true, data: result.data }, null, 2)
        : JSON.stringify({ success: true, data: result.data });
    } catch (error) {
      outputContent = JSON.stringify({
        error: 'Failed to serialize response',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  } else {
    // Default to human-readable format
    outputContent = formatReadable(result.data);
  }

  // Write output
  if (options.output) {
    const dir = path.dirname(options.output);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(options.output, outputContent, 'utf-8');
    console.error(`Output written to: ${options.output}`);
  } else {
    if (!outputContent.endsWith('\n')) {
      outputContent += '\n';
    }
    process.stdout.write(outputContent);
  }
}
