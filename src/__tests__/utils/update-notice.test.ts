import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import packageJson from '../../../package.json';
import {
  maybeShowUpdateNotice,
  formatUpdateNotice,
  type UpdateNoticeOptions,
} from '../../utils/update-notice';
import { getLatestVersion } from '../../utils/npm-registry';
import { formatUpdateBox } from '../../utils/update-notice-format';

vi.mock('../../utils/npm-registry', async () => {
  const actual = await vi.importActual<
    typeof import('../../utils/npm-registry')
  >('../../utils/npm-registry');
  return {
    ...actual,
    getLatestVersion: vi.fn(),
  };
});

describe('update notice', () => {
  let tmpDir: string;
  let originalNoUpdateCheck: string | undefined;
  let write: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firecrawl-update-test-'));
    originalNoUpdateCheck = process.env.FIRECRAWL_NO_UPDATE_CHECK;
    delete process.env.FIRECRAWL_NO_UPDATE_CHECK;
    vi.mocked(getLatestVersion).mockReset();
    write = vi.fn();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalNoUpdateCheck === undefined) {
      delete process.env.FIRECRAWL_NO_UPDATE_CHECK;
    } else {
      process.env.FIRECRAWL_NO_UPDATE_CHECK = originalNoUpdateCheck;
    }
    vi.restoreAllMocks();
  });

  function stderr(isTTY = true): UpdateNoticeOptions['stderr'] {
    return { isTTY, write: write as unknown as NodeJS.WriteStream['write'] };
  }

  it('formats a bordered update notice', () => {
    const notice = formatUpdateNotice('99.99.99');

    expect(notice).toContain(
      `✨ Update available! ${packageJson.version} -> 99.99.99`
    );
    expect(notice).toContain('Run npm install -g firecrawl-cli to update.');
    expect(notice).toContain(
      'https://github.com/firecrawl/cli/releases/latest'
    );
    expect(notice.startsWith('╭')).toBe(true);
    expect(notice.endsWith('╯')).toBe(true);
  });

  it('aligns borders by terminal columns for emoji, color and combining characters', () => {
    expect(
      formatUpdateBox([
        '✨ Done',
        'abc',
        'e\u0301',
        '\x1b[36mOK\x1b[0m',
        '更新',
      ])
    ).toBe(
      [
        '╭─────────╮',
        '│ ✨ Done │',
        '│ abc     │',
        '│ e\u0301       │',
        '│ \x1b[36mOK\x1b[0m      │',
        '│ 更新    │',
        '╰─────────╯',
      ].join('\n')
    );
  });

  it('does not check or print outside a TTY', async () => {
    await maybeShowUpdateNotice({ cacheDir: tmpDir, stderr: stderr(false) });

    expect(getLatestVersion).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('prints a cached newer version', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'update-check.json'),
      JSON.stringify({
        latestVersion: '99.99.99',
        checkedAt: new Date('2026-06-04T12:00:00.000Z').toISOString(),
      })
    );

    await maybeShowUpdateNotice({
      cacheDir: tmpDir,
      now: new Date('2026-06-04T13:00:00.000Z'),
      stderr: stderr(),
    });

    expect(getLatestVersion).not.toHaveBeenCalled();
    // The notice colorizes "Update available!" with ANSI codes on a TTY, so
    // assert on the (uncolorized) version portion that survives formatting.
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining(`${packageJson.version} -> 99.99.99`)
    );
  });

  it('does not print the same update twice within 12 hours', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'update-check.json'),
      JSON.stringify({
        latestVersion: '99.99.99',
        checkedAt: new Date('2026-06-04T12:00:00.000Z').toISOString(),
        lastShownVersion: '99.99.99',
        lastShownAt: new Date('2026-06-04T12:30:00.000Z').toISOString(),
      })
    );

    await maybeShowUpdateNotice({
      cacheDir: tmpDir,
      now: new Date('2026-06-04T13:00:00.000Z'),
      stderr: stderr(),
    });

    expect(getLatestVersion).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('prints the same update again after 12 hours', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'update-check.json'),
      JSON.stringify({
        latestVersion: '99.99.99',
        checkedAt: new Date('2026-06-04T12:00:00.000Z').toISOString(),
        lastShownVersion: '99.99.99',
        lastShownAt: new Date('2026-06-04T00:00:00.000Z').toISOString(),
      })
    );

    await maybeShowUpdateNotice({
      cacheDir: tmpDir,
      now: new Date('2026-06-04T13:00:00.000Z'),
      stderr: stderr(),
    });

    expect(write).toHaveBeenCalledWith(expect.stringContaining('99.99.99'));
  });

  it('prints a different newer version even inside the cooldown', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'update-check.json'),
      JSON.stringify({
        latestVersion: '100.0.0',
        checkedAt: new Date('2026-06-04T12:00:00.000Z').toISOString(),
        lastShownVersion: '99.99.99',
        lastShownAt: new Date('2026-06-04T12:30:00.000Z').toISOString(),
      })
    );

    await maybeShowUpdateNotice({
      cacheDir: tmpDir,
      now: new Date('2026-06-04T13:00:00.000Z'),
      stderr: stderr(),
    });

    expect(write).toHaveBeenCalledWith(expect.stringContaining('100.0.0'));
  });

  it('refreshes a stale cache from npm', async () => {
    vi.mocked(getLatestVersion).mockResolvedValue({
      version: '99.99.99',
      unreachable: false,
    });

    await maybeShowUpdateNotice({
      cacheDir: tmpDir,
      now: new Date('2026-06-04T13:00:00.000Z'),
      stderr: stderr(),
    });

    expect(getLatestVersion).toHaveBeenCalledWith('firecrawl-cli', 750);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('99.99.99'));

    const cached = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'update-check.json'), 'utf-8')
    );
    expect(cached.latestVersion).toBe('99.99.99');
  });

  it('respects FIRECRAWL_NO_UPDATE_CHECK', async () => {
    process.env.FIRECRAWL_NO_UPDATE_CHECK = '1';

    await maybeShowUpdateNotice({ cacheDir: tmpDir, stderr: stderr() });

    expect(getLatestVersion).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
