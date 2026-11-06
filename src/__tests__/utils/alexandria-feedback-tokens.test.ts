import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '', root: '' }));

vi.mock('../../utils/credentials', async () => ({
  ...(await vi.importActual('../../utils/credentials')),
  getConfigDirectoryPath: () => state.dir,
}));

import {
  FEEDBACK_TOKEN_LIMIT,
  FEEDBACK_TOKEN_TTL_MS,
  clearFeedbackTokens,
  feedbackTokenScope,
  readFeedbackTokens,
  recordFeedbackTokens,
} from '../../utils/alexandria-feedback-tokens';

const scope = feedbackTokenScope('fc-key');

describe('alexandria feedback token store', () => {
  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), 'fc-tokens-'));
    state.dir = state.root;
  });

  afterEach(() => {
    rmSync(state.root, { recursive: true, force: true });
  });

  it('keeps a token on one ref across calls', () => {
    expect(recordFeedbackTokens(scope, ['a', 'b'])).toEqual(['c1', 'c2']);
    expect(recordFeedbackTokens(scope, ['b', 'c'])).toEqual(['c2', 'c3']);
    expect(readFeedbackTokens(scope).map((entry) => entry.token)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps the newest tokens up to the limit', () => {
    recordFeedbackTokens(
      scope,
      Array.from({ length: FEEDBACK_TOKEN_LIMIT + 3 }, (_, i) => `t${i}`)
    );
    const tokens = readFeedbackTokens(scope).map((entry) => entry.token);
    expect(tokens).toHaveLength(FEEDBACK_TOKEN_LIMIT);
    expect(tokens[0]).toBe('t3');
  });

  it('drops tokens after 24 hours', () => {
    const start = 1_000_000;
    recordFeedbackTokens(scope, ['old'], start);
    recordFeedbackTokens(scope, ['new'], start + FEEDBACK_TOKEN_TTL_MS - 1);
    expect(
      readFeedbackTokens(scope, start + FEEDBACK_TOKEN_TTL_MS + 1).map(
        (entry) => entry.token
      )
    ).toEqual(['new']);
  });

  it('keeps each credential tokens apart', () => {
    recordFeedbackTokens(scope, ['mine']);
    recordFeedbackTokens(feedbackTokenScope('fc-other'), ['theirs']);
    expect(readFeedbackTokens(scope).map((entry) => entry.token)).toEqual([
      'mine',
    ]);
  });

  it('returns no ref for tokens the cap dropped', () => {
    const tokens = Array.from(
      { length: FEEDBACK_TOKEN_LIMIT + 2 },
      (_, i) => `t${i}`
    );
    const refs = recordFeedbackTokens(scope, tokens);
    expect(refs.slice(0, 2)).toEqual(['', '']);
    expect(refs.slice(2).every(Boolean)).toBe(true);
  });

  it('removes expired tokens from disk on read', () => {
    const start = 1_000_000;
    recordFeedbackTokens(scope, ['old'], start);
    expect(
      readFeedbackTokens(scope, start + FEEDBACK_TOKEN_TTL_MS + 1)
    ).toEqual([]);
    const file = JSON.parse(
      readFileSync(join(state.dir, 'alexandria-feedback-tokens.json'), 'utf-8')
    );
    expect(file.entries).toEqual([]);
  });

  it('breaks a stale lock left by a crashed process', () => {
    const lock = join(state.dir, 'alexandria-feedback-tokens.lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(recordFeedbackTokens(scope, ['a'])).toEqual(['c1']);
  });

  it('clears only the sent tokens', () => {
    recordFeedbackTokens(scope, ['a', 'b', 'c']);
    clearFeedbackTokens(scope, ['a', 'c']);
    expect(readFeedbackTokens(scope).map((entry) => entry.token)).toEqual([
      'b',
    ]);
  });

  it('writes the file with mode 0600', () => {
    recordFeedbackTokens(scope, ['a']);
    const mode =
      statSync(join(state.dir, 'alexandria-feedback-tokens.json')).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
  });

  it('never throws when the store cannot be written', () => {
    const blocker = join(state.root, 'blocker');
    writeFileSync(blocker, '');
    state.dir = join(blocker, 'config');
    expect(recordFeedbackTokens(scope, ['a'])).toEqual([]);
    expect(() => clearFeedbackTokens(scope, ['a'])).not.toThrow();
  });
});
