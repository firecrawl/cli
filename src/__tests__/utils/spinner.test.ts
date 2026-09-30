import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpinner } from '../../utils/spinner';

describe('spinner', () => {
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    originalIsTTY = process.stderr.isTTY;
    stderrWriteSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, 'isTTY', {
      configurable: true,
      value: originalIsTTY,
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setInteractive(isInteractive: boolean): void {
    Object.defineProperty(process.stderr, 'isTTY', {
      configurable: true,
      value: isInteractive,
    });
  }

  it('animates when stderr is attached to a terminal', () => {
    setInteractive(true);
    const spinner = createSpinner('Working...');

    spinner.start();

    expect(stderrWriteSpy).toHaveBeenNthCalledWith(1, '\r\x1b[K');
    expect(stderrWriteSpy).toHaveBeenNthCalledWith(2, '⠋ Working...');

    vi.advanceTimersByTime(80);

    expect(stderrWriteSpy).toHaveBeenNthCalledWith(3, '\r\x1b[K');
    expect(stderrWriteSpy).toHaveBeenNthCalledWith(4, '⠙ Working...');

    spinner.succeed('Done');

    expect(stderrWriteSpy).toHaveBeenNthCalledWith(5, '\r\x1b[K');
    expect(stderrWriteSpy).toHaveBeenNthCalledWith(6, '✓ Done\n');

    vi.advanceTimersByTime(200);
    expect(stderrWriteSpy).toHaveBeenCalledTimes(6);
  });

  it('writes only the final status when stderr is redirected', () => {
    setInteractive(false);
    const spinner = createSpinner('Working...');

    spinner.start();
    spinner.update('Still working...');
    vi.advanceTimersByTime(240);
    spinner.succeed('Done');

    expect(stderrWriteSpy).toHaveBeenCalledTimes(1);
    expect(stderrWriteSpy).toHaveBeenCalledWith('✓ Done\n');
  });

  it('keeps failure messages in redirected output', () => {
    setInteractive(false);
    const spinner = createSpinner('Working...');

    spinner.start();
    spinner.fail('Request failed');

    expect(stderrWriteSpy).toHaveBeenCalledTimes(1);
    expect(stderrWriteSpy).toHaveBeenCalledWith('✗ Request failed\n');
  });

  it('uses the latest message as the redirected final status', () => {
    setInteractive(false);
    const spinner = createSpinner('Working...');

    spinner.start();
    spinner.update('Still working...');
    spinner.succeed();

    expect(stderrWriteSpy).toHaveBeenCalledTimes(1);
    expect(stderrWriteSpy).toHaveBeenCalledWith('✓ Still working...\n');
  });
});
