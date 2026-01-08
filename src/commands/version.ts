/**
 * Version command implementation
 * Displays the CLI version
 */

import packageJson from '../../package.json';

/**
 * Display version information
 */
export function handleVersionCommand(): void {
  console.log(packageJson.version);
}
