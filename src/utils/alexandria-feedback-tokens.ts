/**
 * Local store of Alexandria call feedback tokens, so a later `firecrawl alexandria feedback`
 * process can rate the calls an earlier process made.
 */

import { createHash } from 'crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { getConfigDirectoryPath } from './credentials';

export const FEEDBACK_TOKEN_LIMIT = 20;
export const FEEDBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

export interface StoredFeedbackToken {
  ref: string;
  token: string;
  scope: string;
  at: number;
}

interface StoreFile {
  counter: number;
  entries: StoredFeedbackToken[];
}

function storePath(): string {
  return join(getConfigDirectoryPath(), 'alexandria-feedback-tokens.json');
}

/** Tokens belong to one team, so they are only offered back to the credential that received them. */
export function feedbackTokenScope(apiKey?: string): string {
  return createHash('sha256')
    .update(apiKey ?? '')
    .digest('hex')
    .slice(0, 16);
}

function load(now: number): { store: StoreFile; pruned: boolean } {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf-8'));
    const all: StoredFeedbackToken[] = Array.isArray(parsed?.entries)
      ? parsed.entries
      : [];
    const entries = all.filter(
      (entry) =>
        typeof entry?.ref === 'string' &&
        typeof entry.token === 'string' &&
        typeof entry.scope === 'string' &&
        typeof entry.at === 'number' &&
        entry.at > now - FEEDBACK_TOKEN_TTL_MS
    );
    return {
      store: {
        counter: Number.isInteger(parsed?.counter) ? parsed.counter : 0,
        entries,
      },
      pruned: entries.length !== all.length,
    };
  } catch {
    return { store: { counter: 0, entries: [] }, pruned: false };
  }
}

function save(store: StoreFile): void {
  const path = storePath();
  const dir = getConfigDirectoryPath();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** Serializes read-modify-write across processes with an exclusive lock directory. */
function withLock<T>(run: () => T): T {
  const dir = getConfigDirectoryPath();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'alexandria-feedback-tokens.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS)
          rmdirSync(lock);
      } catch {
        // Released by its owner in the meantime.
      }
      if (Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return run();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Already removed as stale.
    }
  }
}

/** Tokens of one credential that are still valid, oldest first. */
export function readFeedbackTokens(
  scope: string,
  now = Date.now()
): StoredFeedbackToken[] {
  const { store, pruned } = load(now);
  if (pruned) {
    try {
      withLock(() => {
        const current = load(now);
        if (current.pruned) save(current.store);
      });
    } catch {
      // Expired entries are ignored on every read either way.
    }
  }
  return store.entries.filter((entry) => entry.scope === scope);
}

/**
 * Stores call tokens and returns each one's ref, or an empty string for a token the
 * cap dropped. A token seen before keeps its ref, and the oldest tokens of the scope
 * are dropped past the limit. Storage failures never fail the command.
 */
export function recordFeedbackTokens(
  scope: string,
  tokens: string[],
  now = Date.now()
): string[] {
  try {
    return withLock(() => {
      const { store } = load(now);
      const refs = tokens.map((token) => {
        const known = store.entries.find(
          (entry) => entry.scope === scope && entry.token === token
        );
        if (known) return known.ref;
        const ref = `c${++store.counter}`;
        store.entries.push({ ref, token, scope, at: now });
        return ref;
      });
      const mine = store.entries.filter((entry) => entry.scope === scope);
      const dropped = new Set(mine.slice(0, -FEEDBACK_TOKEN_LIMIT));
      store.entries = store.entries.filter((entry) => !dropped.has(entry));
      save(store);
      const kept = new Set(store.entries.map((entry) => entry.ref));
      return refs.map((ref) => (kept.has(ref) ? ref : ''));
    });
  } catch {
    return [];
  }
}

export function clearFeedbackTokens(
  scope: string,
  tokens: string[],
  now = Date.now()
): void {
  try {
    const sent = new Set(tokens);
    withLock(() => {
      const { store, pruned } = load(now);
      const kept = store.entries.filter(
        (entry) => entry.scope !== scope || !sent.has(entry.token)
      );
      if (!pruned && kept.length === store.entries.length) return;
      save({ ...store, entries: kept });
    });
  } catch {
    // The tokens expire on their own.
  }
}
