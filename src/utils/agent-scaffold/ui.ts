/**
 * Vendored from firecrawl/web-agent:.internal/cli/src/utils/ui.ts
 * Keep in sync if upstream changes — this file intentionally mirrors the
 * agent repo's CLI output style so scaffold messages match docs verbatim.
 */

import {
  bold,
  cyan,
  dim,
  green,
  orange,
  red,
  reset,
  yellow,
} from '../terminal';

export { bold, cyan, dim, green, orange, red, reset, yellow };

export function printBanner(): void {
  console.log('');
  console.log(`  ${orange}${bold}firecrawl-agent${reset}`);
  console.log(`  ${dim}AI-powered web research agent${reset}`);
  console.log('');
}

export function step(n: number, label: string): void {
  console.log(`  ${dim}${n}.${reset} ${label}`);
}

export function success(msg: string): void {
  console.log(`  ${green}✓${reset} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${yellow}!${reset} ${msg}`);
}

export function error(msg: string): void {
  console.log(`  ${red}✗${reset} ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${dim}${msg}${reset}`);
}
