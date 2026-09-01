/**
 * Tests for agent thread memory
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  apiKeyFingerprint,
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
    expect(getRememberedThread('fc-test-key')).toBeNull();
  });

  it('round-trips the last thread and run for an API key', () => {
    rememberThread('fc-test-key', { threadId: 'thread-1', runId: 'run-1' });

    const remembered = getRememberedThread('fc-test-key');
    expect(remembered?.lastThreadId).toBe('thread-1');
    expect(remembered?.lastRunId).toBe('run-1');
    expect(Date.parse(remembered?.updatedAt ?? '')).not.toBeNaN();
  });

  it('keys entries by a hash of the API key, never the key itself', () => {
    rememberThread('fc-test-key', { threadId: 'thread-1' });

    const store = loadAgentThreadStore();
    expect(Object.keys(store)).toEqual([apiKeyFingerprint('fc-test-key')]);
    expect(JSON.stringify(store)).not.toContain('fc-test-key');
  });

  it('keeps threads for different API keys apart', () => {
    rememberThread('fc-key-a', { threadId: 'thread-a' });
    rememberThread('fc-key-b', { threadId: 'thread-b' });

    expect(getRememberedThread('fc-key-a')?.lastThreadId).toBe('thread-a');
    expect(getRememberedThread('fc-key-b')?.lastThreadId).toBe('thread-b');
  });

  it('forgets only the entry for the given API key', () => {
    rememberThread('fc-key-a', { threadId: 'thread-a' });
    rememberThread('fc-key-b', { threadId: 'thread-b' });

    forgetThread('fc-key-a');

    expect(getRememberedThread('fc-key-a')).toBeNull();
    expect(getRememberedThread('fc-key-b')?.lastThreadId).toBe('thread-b');
  });

  it('treats a corrupt file as empty rather than failing the command', () => {
    fs.writeFileSync(getAgentThreadsPath(), 'not json', 'utf-8');

    expect(loadAgentThreadStore()).toEqual({});
    expect(getRememberedThread('fc-test-key')).toBeNull();
  });
});
