import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgressLine, createSpinner } from '../../utils/spinner';

describe('terminal progress output', () => {
  let writes: string[];
  const originalIsTTY = process.stderr.isTTY;

  const setTTY = (value: boolean) => {
    Object.defineProperty(process.stderr, 'isTTY', {
      value,
      configurable: true,
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('TERM', 'xterm-256color');
    writes = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setTTY(originalIsTTY);
  });

  describe('when stderr is not a terminal', () => {
    beforeEach(() => setTTY(false));

    it('prints each distinct spinner message once, with no frames or escapes', () => {
      const spinner = createSpinner('Starting agent...');
      spinner.start();
      spinner.update('Agent running... (Job ID: abc)');
      vi.advanceTimersByTime(5000);
      spinner.update('Agent running... (Job ID: abc)');
      spinner.update('Agent running... (Job ID: abc)');
      spinner.succeed('Agent completed');

      expect(writes).toEqual([
        'Starting agent...\n',
        'Agent running... (Job ID: abc)\n',
        '✓ Agent completed\n',
      ]);
    });

    it('prints a progress line only when it changes', () => {
      const progress = createProgressLine();
      progress.update('Progress: 0/2 pages (scraping)');
      progress.update('Progress: 0/2 pages (scraping)');
      progress.update('Progress: 2/2 pages (completed)');
      progress.end();

      expect(writes).toEqual([
        'Progress: 0/2 pages (scraping)\n',
        'Progress: 2/2 pages (completed)\n',
      ]);
    });
  });

  it('treats TERM=dumb as non-interactive', () => {
    setTTY(true);
    vi.stubEnv('TERM', 'dumb');
    const spinner = createSpinner('Working...');
    spinner.start();
    vi.advanceTimersByTime(1000);
    spinner.stop();

    expect(writes).toEqual(['Working...\n']);
  });

  describe('when stderr is a terminal', () => {
    beforeEach(() => setTTY(true));

    it('animates the spinner in place and clears it on stop', () => {
      const spinner = createSpinner('Working...');
      spinner.start();
      vi.advanceTimersByTime(160);
      spinner.succeed('Done');

      expect(writes).toHaveLength(5);
      expect(writes[0]).toBe('\r\x1b[K⠋ Working...');
      expect(writes.at(-2)).toBe('\r\x1b[K');
      expect(writes.at(-1)).toBe('✓ Done\n');
    });

    it('redraws the progress line in place and ends it with a newline', () => {
      const progress = createProgressLine();
      progress.update('Progress: 0/2 pages (scraping)');
      progress.update('Progress: 2/2 pages (completed)');
      progress.end();

      expect(writes).toEqual([
        '\r\x1b[KProgress: 0/2 pages (scraping)',
        '\r\x1b[KProgress: 2/2 pages (completed)',
        '\n',
      ]);
    });
  });
});
