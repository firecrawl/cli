/**
 * Tests for agent thread memory
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  threadFingerprint,
  forgetThread,
  getRememberedThread,
  loadAgentThreadStore,
  rememberThread,
} from '../../utils/agent-threads';
import { getAgentThreadsPath } from '../../utils/config';

const { configDir } = vi.hoisted(() => ({ configDir: { path: '' } }));

vi.mock('../../utils/credentials', () => ({
  loadCredentials: () => null,
  getConfigDirectoryPath: () => configDir.path,
}));

describe('agent thread memory', () => {
  beforeEach(() => {
    configDir.path = fs.mkdtempSync(
      path.join(os.tmpdir(), 'firecrawl-threads-test-')
    );
  });

  afterEach(() => {
    fs.rmSync(configDir.path, { recursive: true, force: true });
  });

  it('stores the file next to the other config-dir files', () => {
    expect(getAgentThreadsPath()).toBe(
      path.join(configDir.path, 'agent-threads.json')
    );
  });

  it('returns nothing when no thread has been started', () => {
    expect(getRememberedThread({ apiKey: 'fc-test-key' })).toBeNull();
  });

  it('round-trips the last thread and run for an API key', () => {
    rememberThread(
      { apiKey: 'fc-test-key' },
      { threadId: 'thread-1', runId: 'run-1' }
    );

    const remembered = getRememberedThread({ apiKey: 'fc-test-key' });
    expect(remembered?.lastThreadId).toBe('thread-1');
    expect(remembered?.lastRunId).toBe('run-1');
    expect(Date.parse(remembered?.updatedAt ?? '')).not.toBeNaN();
  });

  it('keys entries by a hash of the API key, never the key itself', () => {
    rememberThread({ apiKey: 'fc-test-key' }, { threadId: 'thread-1' });

    const store = loadAgentThreadStore();
    expect(Object.keys(store)).toEqual([
      threadFingerprint({ apiKey: 'fc-test-key' }),
    ]);
    expect(JSON.stringify(store)).not.toContain('fc-test-key');
  });

  it('keeps threads for different API keys apart', () => {
    rememberThread({ apiKey: 'fc-key-a' }, { threadId: 'thread-a' });
    rememberThread({ apiKey: 'fc-key-b' }, { threadId: 'thread-b' });

    expect(getRememberedThread({ apiKey: 'fc-key-a' })?.lastThreadId).toBe(
      'thread-a'
    );
    expect(getRememberedThread({ apiKey: 'fc-key-b' })?.lastThreadId).toBe(
      'thread-b'
    );
  });

  it('forgets only the entry for the given API key', () => {
    rememberThread({ apiKey: 'fc-key-a' }, { threadId: 'thread-a' });
    rememberThread({ apiKey: 'fc-key-b' }, { threadId: 'thread-b' });

    forgetThread({ apiKey: 'fc-key-a' });

    expect(getRememberedThread({ apiKey: 'fc-key-a' })).toBeNull();
    expect(getRememberedThread({ apiKey: 'fc-key-b' })?.lastThreadId).toBe(
      'thread-b'
    );
  });

  it('keeps two keyless servers apart', () => {
    // Self-hosted setups have no key to tell them apart, so without the server
    // in the identity one would be handed the other's thread ID and a 404
    // would erase the original.
    const a = { baseUrl: 'http://localhost:3002' };
    const b = { baseUrl: 'http://localhost:4002' };
    rememberThread(a, { threadId: 'thread-a' });
    rememberThread(b, { threadId: 'thread-b' });

    expect(getRememberedThread(a)?.lastThreadId).toBe('thread-a');
    expect(getRememberedThread(b)?.lastThreadId).toBe('thread-b');
  });

  it('reads one server through the spellings of its URL', () => {
    rememberThread(
      { apiKey: 'fc-test-key', baseUrl: 'https://API.firecrawl.dev/' },
      { threadId: 'thread-1' }
    );

    expect(
      getRememberedThread({
        apiKey: 'fc-test-key',
        baseUrl: 'https://api.firecrawl.dev',
      })?.lastThreadId
    ).toBe('thread-1');
    // And the default is that same server, spelled by omission.
    expect(getRememberedThread({ apiKey: 'fc-test-key' })?.lastThreadId).toBe(
      'thread-1'
    );
  });

  it('keeps an entry a concurrent writer added', () => {
    rememberThread({ apiKey: 'fc-key-a' }, { threadId: 'thread-a' });

    // What a second process does between this process reading the store and
    // writing it back. Without the update being one step, this entry is the
    // one that disappears.
    const concurrent = loadAgentThreadStore();
    rememberThread({ apiKey: 'fc-key-b' }, { threadId: 'thread-b' });
    expect(Object.keys(concurrent)).toHaveLength(1);

    expect(getRememberedThread({ apiKey: 'fc-key-a' })?.lastThreadId).toBe(
      'thread-a'
    );
    expect(getRememberedThread({ apiKey: 'fc-key-b' })?.lastThreadId).toBe(
      'thread-b'
    );
  });

  it('writes through a lock it cannot take rather than hanging', () => {
    // Held right now, so the attempts run out and the update goes ahead
    // anyway. Memory is a convenience and is not worth failing a run over.
    fs.writeFileSync(`${getAgentThreadsPath()}.lock`, '', 'utf-8');

    rememberThread({ apiKey: 'fc-test-key' }, { threadId: 'thread-1' });

    expect(getRememberedThread({ apiKey: 'fc-test-key' })?.lastThreadId).toBe(
      'thread-1'
    );
  });

  it('clears a lock whose holder is long gone', () => {
    const lockPath = `${getAgentThreadsPath()}.lock`;
    fs.writeFileSync(lockPath, '', 'utf-8');
    // Older than any run could plausibly hold it, so the holder is assumed
    // dead and the lock is taken rather than waited out.
    const ancient = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, ancient, ancient);

    rememberThread({ apiKey: 'fc-test-key' }, { threadId: 'thread-1' });

    expect(getRememberedThread({ apiKey: 'fc-test-key' })?.lastThreadId).toBe(
      'thread-1'
    );
    // Taken and released, not left where it was found.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('takes a lock on a machine that has no config directory yet', () => {
    // The lock lives in that directory, so without creating it first the very
    // first run on a machine spends every attempt failing to make one and then
    // writes unlocked, which is exactly when two runs are both likely to be
    // first.
    fs.rmSync(configDir.path, { recursive: true, force: true });

    const started = Date.now();
    rememberThread({ apiKey: 'fc-test-key' }, { threadId: 'thread-1' });

    expect(getRememberedThread({ apiKey: 'fc-test-key' })?.lastThreadId).toBe(
      'thread-1'
    );
    // Exhausting the attempts would take the full acquire budget.
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('leaves no lock behind', () => {
    rememberThread({ apiKey: 'fc-test-key' }, { threadId: 'thread-1' });
    forgetThread({ apiKey: 'fc-test-key' });

    expect(fs.existsSync(`${getAgentThreadsPath()}.lock`)).toBe(false);
  });

  it('treats a corrupt file as empty rather than failing the command', () => {
    fs.writeFileSync(getAgentThreadsPath(), 'not json', 'utf-8');

    expect(loadAgentThreadStore()).toEqual({});
    expect(getRememberedThread({ apiKey: 'fc-test-key' })).toBeNull();
  });
});
