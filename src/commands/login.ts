/**
 * Login command implementation
 * Handles both manual API key entry and browser-based authentication
 */

import { saveCredentials, getConfigDirectoryPath } from '../utils/credentials';
import { updateConfig } from '../utils/config';
import {
  browserLogin,
  manualLogin,
  interactiveLogin,
  isAuthenticated,
} from '../utils/auth';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';
const WEB_URL = 'https://firecrawl.dev';

export interface LoginOptions {
  apiKey?: string;
  apiUrl?: string;
  webUrl?: string;
  method?: 'browser' | 'manual';
}

/**
 * Main login command handler
 */
export async function handleLoginCommand(
  options: LoginOptions = {}
): Promise<void> {
  const apiUrl = options.apiUrl?.replace(/\/$/, '') || DEFAULT_API_URL;
  const webUrl = options.webUrl?.replace(/\/$/, '') || WEB_URL;
  const isCustomUrl = apiUrl !== DEFAULT_API_URL;

  // If already authenticated, let them know
  if (isAuthenticated() && !options.apiKey && !options.method && !isCustomUrl) {
    console.log('You are already logged in.');
    console.log(`Credentials stored at: ${getConfigDirectoryPath()}`);
    console.log('\nTo login with a different account, run:');
    console.log('  firecrawl logout');
    console.log('  firecrawl login');
    return;
  }

  // If API key provided directly, save it
  if (options.apiKey) {
    // Only validate fc- prefix for cloud API
    if (!isCustomUrl && !options.apiKey.startsWith('fc-')) {
      console.error(
        'Error: Invalid API key format. API keys should start with "fc-"'
      );
      process.exit(1);
    }

    try {
      saveCredentials({
        apiKey: options.apiKey,
        apiUrl: apiUrl,
      });
      console.log('✓ Login successful!');

      updateConfig({
        apiKey: options.apiKey,
        apiUrl: apiUrl,
      });
    } catch (error) {
      console.error(
        'Error saving credentials:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      process.exit(1);
    }
    return;
  }

  try {
    let result: { apiKey: string; apiUrl: string; teamName?: string };

    if (options.method === 'manual') {
      result = await manualLogin(apiUrl);
    } else if (options.method === 'browser') {
      result = await browserLogin(webUrl);
    } else {
      result = await interactiveLogin(webUrl, apiUrl);
    }

    // Save credentials
    saveCredentials({
      apiKey: result.apiKey,
      apiUrl: result.apiUrl || apiUrl,
    });

    console.log('\n✓ Login successful!');
    if (result.teamName) {
      console.log(`  Team: ${result.teamName}`);
    }

    updateConfig({
      apiKey: result.apiKey,
      apiUrl: result.apiUrl || apiUrl,
    });
  } catch (error) {
    console.error(
      '\nError:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    process.exit(1);
  }
}
