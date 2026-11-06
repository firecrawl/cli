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
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { getConfigDirectoryPath } from './credentials';

export const FEEDBACK_TOKEN_LIMIT = 20;
export const FEEDBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

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

function load(now: number): StoreFile {
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf-8'));
    const entries: StoredFeedbackToken[] = Array.isArray(parsed?.entries)
      ? parsed.entries.filter(
          (entry: StoredFeedbackToken) =>
            typeof entry?.ref === 'string' &&
            typeof entry.token === 'string' &&
            typeof entry.scope === 'string' &&
            typeof entry.at === 'number' &&
            entry.at > now - FEEDBACK_TOKEN_TTL_MS
        )
      : [];
    return {
      counter: Number.isInteger(parsed?.counter) ? parsed.counter : 0,
      entries,
    };
  } catch {
    return { counter: 0, entries: [] };
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

/** Tokens of one credential that are still valid, oldest first. */
export function readFeedbackTokens(
  scope: string,
  now = Date.now()
): StoredFeedbackToken[] {
  return load(now).entries.filter((entry) => entry.scope === scope);
}

/**
 * Stores call tokens and returns each one's ref. A token seen before keeps its ref,
 * and the oldest tokens of the scope are dropped past the limit. Storage failures
 * never fail the command.
 */
export function recordFeedbackTokens(
  scope: string,
  tokens: string[],
  now = Date.now()
): string[] {
  try {
    const store = load(now);
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
    return refs;
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
    const store = load(now);
    const kept = store.entries.filter(
      (entry) => entry.scope !== scope || !sent.has(entry.token)
    );
    if (kept.length === store.entries.length) return;
    save({ ...store, entries: kept });
  } catch {
    // The tokens expire on their own.
  }
}
