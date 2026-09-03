/**
 * Agent thread memory
 * Remembers the last agent thread per account so `firecrawl agent --continue`
 * can pick the conversation back up without pasting a thread ID.
 *
 * Stored in the same config directory as credentials.json / browser-session.json
 * / interact-session.json. Entries are keyed by a hash of the server and the key
 * used to reach it, so neither switching accounts nor pointing at another server
 * can cross threads. The file is a convenience, never the source of truth: the
 * API owns thread state, and a thread the server no longer knows about is
 * dropped from here on the next attempt to use it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { DEFAULT_API_URL, getAgentThreadsPath } from './config';
import { getConfigDirectoryPath } from './credentials';

export interface RememberedThread {
  lastThreadId: string;
  lastRunId?: string;
  updatedAt: string;
}

/** `{ [threadFingerprint]: RememberedThread }` */
export type AgentThreadStore = Record<string, RememberedThread>;

/**
 * Which server, as which account. Both halves matter: a thread ID only means
 * something to the server that issued it, and two keyless self-hosted servers
 * would otherwise share one bucket and hand each other's IDs back.
 *
 * Callers pass what the request will actually use, not what a flag carried:
 * the key usually comes from the environment or stored credentials rather than
 * `--api-key`, and reading the flag alone puts every such run in one bucket.
 */
export interface ThreadIdentity {
  apiKey?: string;
  baseUrl?: string;
}

/** Stands in for the key on self-hosted setups that do not use one. */
const NO_API_KEY = 'no-api-key';

function normalizeBaseUrl(baseUrl?: string): string {
  const raw = baseUrl?.trim() || DEFAULT_API_URL;
  try {
    const url = new URL(raw);
    // Host casing and a trailing slash are not a different server.
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return raw.replace(/\/$/, '').toLowerCase();
  }
}

/**
 * Short, stable hash of the identity. Neither the key nor anything else secret
 * is written to disk by this file; credentials.json already owns that.
 */
export function threadFingerprint(identity: ThreadIdentity): string {
  const key = identity.apiKey?.trim() || NO_API_KEY;
  return crypto
    .createHash('sha256')
    .update(`${normalizeBaseUrl(identity.baseUrl)}\n${key}`)
    .digest('hex')
    .slice(0, 16);
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
  // Written beside the store and renamed over it, so a reader never sees the
  // half of a file that a crash or a concurrent run left behind.
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(tmpPath, storePath);
  try {
    fs.chmodSync(storePath, 0o600);
  } catch {
    // Ignore on Windows
  }
}

const LOCK_ATTEMPTS = 20;
const LOCK_WAIT_MS = 10;
/** Past this the holder is assumed dead rather than slow. */
const LOCK_STALE_MS = 5000;

function sleepSync(ms: number): void {
  // The whole update is synchronous, so the wait has to be too.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read, change and write the store as one step.
 *
 * Two agent runs finishing together would otherwise each read the same store
 * and write their own entry over the other's, and the run that lost would
 * silently start a new thread on its next `--continue`.
 *
 * Best effort by design: if the lock cannot be taken the update still happens.
 * Thread memory is a convenience, and no version of this is worth hanging a
 * command over.
 */
function updateStore(change: (store: AgentThreadStore) => void): void {
  const lockPath = `${getAgentThreadsPath()}.lock`;
  let held: number | undefined;

  for (let attempt = 0; attempt < LOCK_ATTEMPTS && held === undefined; ) {
    try {
      held = fs.openSync(lockPath, 'wx');
    } catch {
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // The holder released it between the open and the stat; try again.
      }
      attempt += 1;
      sleepSync(LOCK_WAIT_MS);
    }
  }

  try {
    const store = loadAgentThreadStore();
    change(store);
    writeAgentThreadStore(store);
  } finally {
    if (held !== undefined) {
      try {
        fs.closeSync(held);
        fs.unlinkSync(lockPath);
      } catch {
        // Already gone, or never ours to remove
      }
    }
  }
}

/** Read the thread last started against this server with this key, if any. */
export function getRememberedThread(
  identity: ThreadIdentity
): RememberedThread | null {
  const entry = loadAgentThreadStore()[threadFingerprint(identity)];
  if (!entry || typeof entry.lastThreadId !== 'string') return null;
  return entry;
}

/** Record a thread after a successful start. Never throws. */
export function rememberThread(
  identity: ThreadIdentity,
  thread: { threadId: string; runId?: string }
): void {
  try {
    updateStore((store) => {
      store[threadFingerprint(identity)] = {
        lastThreadId: thread.threadId,
        ...(thread.runId ? { lastRunId: thread.runId } : {}),
        updatedAt: new Date().toISOString(),
      };
    });
  } catch {
    // Thread memory is a convenience; a failed write must not fail the run
  }
}

/** Drop the remembered thread for this identity (e.g. the server 404s it). */
export function forgetThread(identity: ThreadIdentity): void {
  try {
    updateStore((store) => {
      delete store[threadFingerprint(identity)];
    });
  } catch {
    // Ignore errors
  }
}
