/**
 * World ID credential for the keyless tier.
 *
 * A verified human's `fcwid_` credential (from `firecrawl world-id verify`)
 * is sent as `x-firecrawl-world-id` on keyless requests, which the API then
 * counts against that human's own bucket instead of the IP. The API ignores
 * the header while the feature is off.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDirectoryPath } from './credentials';

export const WORLD_ID_HEADER = 'x-firecrawl-world-id';

export interface StoredWorldIdCredential {
  credential: string;
  expiresAt: string;
}

function worldIdPath(): string {
  return path.join(getConfigDirectoryPath(), 'world-id.json');
}

export function loadWorldIdCredential(): StoredWorldIdCredential | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(worldIdPath(), 'utf-8'));
    if (
      typeof parsed?.credential !== 'string' ||
      typeof parsed?.expiresAt !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveWorldIdCredential(stored: StoredWorldIdCredential): void {
  fs.mkdirSync(getConfigDirectoryPath(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(worldIdPath(), JSON.stringify(stored, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.chmodSync(worldIdPath(), 0o600);
}

export function clearWorldIdCredential(): boolean {
  if (!fs.existsSync(worldIdPath())) return false;
  fs.unlinkSync(worldIdPath());
  return true;
}

/**
 * The credential to send: FIRECRAWL_WORLD_ID wins, else the stored one while
 * it has not expired.
 */
export function activeWorldIdCredential(now = Date.now()): string | undefined {
  const fromEnv = process.env.FIRECRAWL_WORLD_ID?.trim();
  if (fromEnv) return fromEnv;
  const stored = loadWorldIdCredential();
  if (!stored) return undefined;
  const expiresAt = Date.parse(stored.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now
    ? stored.credential
    : undefined;
}

export function worldIdHeaders(): Record<string, string> {
  const credential = activeWorldIdCredential();
  return credential ? { [WORLD_ID_HEADER]: credential } : {};
}
