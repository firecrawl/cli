/**
 * Config command implementation
 * Handles configuration and authentication
 */

import { loadCredentials, getConfigDirectoryPath } from '../utils/credentials';
import { getConfig } from '../utils/config';
import { isAuthenticated, ensureAuthenticated } from '../utils/auth';

export interface ConfigureOptions {
  apiKey?: string;
  apiUrl?: string;
  webUrl?: string;
  method?: 'browser' | 'manual';
}

/**
 * Configure/login - triggers login flow when not authenticated
 */
export async function configure(options: ConfigureOptions = {}): Promise<void> {
  // If not authenticated, trigger the login flow
  if (!isAuthenticated() || options.apiKey || options.method) {
    // Import handleLoginCommand to avoid circular dependency
    const { handleLoginCommand } = await import('./login');
    await handleLoginCommand({
      apiKey: options.apiKey,
      apiUrl: options.apiUrl,
      webUrl: options.webUrl,
      method: options.method,
    });
    return;
  }

  // Already authenticated - show config and offer to re-authenticate
  await viewConfig();
  console.log(
    'To re-authenticate, run: firecrawl logout && firecrawl config\n'
  );
}

/**
 * View current configuration (read-only)
 */
export async function viewConfig(): Promise<void> {
  const credentials = loadCredentials();
  const config = getConfig();

  console.log('\n┌─────────────────────────────────────────┐');
  console.log('│          Firecrawl Configuration        │');
  console.log('└─────────────────────────────────────────┘\n');

  if (isAuthenticated()) {
    const maskedKey = credentials?.apiKey
      ? `${credentials.apiKey.substring(0, 6)}...${credentials.apiKey.slice(-4)}`
      : 'Not set';

    console.log('Status: ✓ Authenticated\n');
    console.log(`API Key:  ${maskedKey}`);
    console.log(`API URL:  ${config.apiUrl || 'https://api.firecrawl.dev'}`);
    console.log(`Config:   ${getConfigDirectoryPath()}`);
    console.log('\nCommands:');
    console.log('  firecrawl logout       Clear credentials');
    console.log('  firecrawl config       Re-authenticate');
  } else {
    console.log('Status: Not authenticated\n');
    console.log('Run any command to start authentication, or use:');
    console.log('  firecrawl config    Authenticate with browser or API key');
  }
  console.log('');
}
