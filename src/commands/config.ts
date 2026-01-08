/**
 * Config command implementation
 * Manages stored credentials and configuration
 */

import * as readline from 'readline';
import { saveCredentials, getConfigDirectoryPath } from '../utils/credentials';
import { updateConfig } from '../utils/config';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';

/**
 * Prompt for input (for secure API key entry)
 */
function promptInput(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promptText = defaultValue
    ? `${question} [${defaultValue}]: `
    : `${question} `;

  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Interactive configuration setup
 * Asks for API URL and API key
 */
export async function configure(): Promise<void> {
  console.log('Firecrawl Configuration Setup\n');

  // Prompt for API URL with default
  let url = await promptInput('Enter API URL', DEFAULT_API_URL);

  // Ensure URL doesn't end with trailing slash
  url = url.replace(/\/$/, '');

  // Prompt for API key
  const key = await promptInput('Enter your Firecrawl API key: ');

  if (!key || key.trim().length === 0) {
    console.error('Error: API key cannot be empty');
    process.exit(1);
  }

  if (!url || url.trim().length === 0) {
    console.error('Error: API URL cannot be empty');
    process.exit(1);
  }

  // Normalize URL (remove trailing slash)
  const normalizedUrl = url.trim().replace(/\/$/, '');

  try {
    saveCredentials({
      apiKey: key.trim(),
      apiUrl: normalizedUrl,
    });
    console.log('\n✓ Configuration saved successfully');
    console.log(`  API URL: ${normalizedUrl}`);
    console.log(`  Stored in: ${getConfigDirectoryPath()}`);

    // Update global config
    updateConfig({
      apiKey: key.trim(),
      apiUrl: normalizedUrl,
    });
  } catch (error) {
    console.error(
      'Error saving configuration:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    process.exit(1);
  }
}
