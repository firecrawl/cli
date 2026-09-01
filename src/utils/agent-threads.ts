/**
 * Agent thread memory
 * Remembers the last agent thread per API key so `firecrawl agent --continue`
 * can pick the conversation back up without pasting a thread ID.
 *
 * Stored in the same config directory as credentials.json / browser-session.json
 * / interact-session.json. Entries are keyed by a hash of the API key so
 * switching keys never crosses threads. The file is a convenience, never the
 * source of truth: the API owns thread state, and a thread the server no longer
 * knows about is dropped from here on the next attempt to use it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { getAgentThreadsPath } from './config';
import { getConfigDirectoryPath } from './credentials';

export interface RememberedThread {
  lastThreadId: string;
  lastRunId?: string;
  updatedAt: string;
}

/** `{ [apiKeyFingerprint]: RememberedThread }` */
export type AgentThreadStore = Record<string, RememberedThread>;

/** Bucket used when no API key is configured (self-hosted / keyless setups). */
const NO_API_KEY = 'no-api-key';

/**
 * Short, stable hash of the API key. The key itself is never written to disk by
 * this file; credentials.json already owns that.
 */
export function apiKeyFingerprint(apiKey?: string): string {
  const key = apiKey?.trim();
  if (!key) return NO_API_KEY;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function loadAgentThreadStore(): AgentThreadStore {
  try {
    const storePath = getAgentThreadsPath();
    if (!fs.existsSync(storePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as AgentThreadStore;
  } catch {
    // Corrupt or unreadable file: start over rather than blocking the command
    return {};
  }
}

function writeAgentThreadStore(store: AgentThreadStore): void {
  const configDir = getConfigDirectoryPath();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  const storePath = getAgentThreadsPath();
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
  try {
    fs.chmodSync(storePath, 0o600);
  } catch {
    // Ignore on Windows
  }
}

/** Read the thread last started with this API key, if any. */
export function getRememberedThread(apiKey?: string): RememberedThread | null {
  const entry = loadAgentThreadStore()[apiKeyFingerprint(apiKey)];
  if (!entry || typeof entry.lastThreadId !== 'string') return null;
  return entry;
}

/** Record a thread after a successful start. Never throws. */
export function rememberThread(
  apiKey: string | undefined,
  thread: { threadId: string; runId?: string }
): void {
  try {
    const store = loadAgentThreadStore();
    store[apiKeyFingerprint(apiKey)] = {
      lastThreadId: thread.threadId,
      ...(thread.runId ? { lastRunId: thread.runId } : {}),
      updatedAt: new Date().toISOString(),
    };
    writeAgentThreadStore(store);
  } catch {
    // Thread memory is a convenience; a failed write must not fail the run
  }
}

/** Drop the remembered thread for this API key (e.g. the server 404s it). */
export function forgetThread(apiKey?: string): void {
  try {
    const store = loadAgentThreadStore();
    const fingerprint = apiKeyFingerprint(apiKey);
    if (!(fingerprint in store)) return;
    delete store[fingerprint];
    writeAgentThreadStore(store);
  } catch {
    // Ignore errors
  }
}
