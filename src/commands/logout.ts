/**
 * Logout command implementation
 * Clears stored credentials
 */

import {
  deleteCredentials,
  loadCredentials,
  getConfigDirectoryPath,
} from '../utils/credentials';
import { updateConfig } from '../utils/config';

/**
 * Main logout command handler
 */
export async function handleLogoutCommand(): Promise<void> {
  const credentials = loadCredentials();

  if (!credentials || !credentials.apiKey) {
    console.log('No credentials found. You are not logged in.');
    return;
  }

  try {
    deleteCredentials();
    // Clear the global config
    updateConfig({
      apiKey: '',
      apiUrl: '',
    });

    console.log('✓ Logged out successfully');
  } catch (error) {
    console.error(
      'Error logging out:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    process.exit(1);
  }
}
