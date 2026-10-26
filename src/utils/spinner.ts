/**
 * Transient progress output on stderr. On a terminal it redraws one line in
 * place; anywhere else it prints a plain line each time the message changes.
 */

import { isInteractive } from './terminal';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CLEAR_LINE = '\r\x1b[K';

export interface Spinner {
  start: (message?: string) => void;
  update: (message: string) => void;
  stop: (finalMessage?: string) => void;
  succeed: (message?: string) => void;
  fail: (message?: string) => void;
}

export function createSpinner(initialMessage: string = ''): Spinner {
  const interactive = isInteractive(process.stderr);
  let frameIndex = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentMessage = initialMessage;
  let printedMessage: string | undefined;

  const render = () => {
    const frame = SPINNER_FRAMES[frameIndex];
    process.stderr.write(`${CLEAR_LINE}${frame} ${currentMessage}`);
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  };

  const printIfChanged = () => {
    if (!currentMessage || currentMessage === printedMessage) return;
    process.stderr.write(`${currentMessage}\n`);
    printedMessage = currentMessage;
  };

  return {
    start(message?: string) {
      if (message) currentMessage = message;
      if (!interactive) return printIfChanged();
      if (interval) return;
      render();
      interval = setInterval(render, 80);
    },

    update(message: string) {
      currentMessage = message;
      if (!interactive) printIfChanged();
    },

    stop(finalMessage?: string) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (interactive) process.stderr.write(CLEAR_LINE);
      if (finalMessage) {
        process.stderr.write(`${finalMessage}\n`);
      }
    },

    succeed(message?: string) {
      this.stop(`✓ ${message || currentMessage}`);
    },

    fail(message?: string) {
      this.stop(`✗ ${message || currentMessage}`);
    },
  };
}

export interface ProgressLine {
  update: (text: string) => void;
  end: () => void;
}

export function createProgressLine(): ProgressLine {
  const interactive = isInteractive(process.stderr);
  let lastText: string | undefined;

  return {
    update(text: string) {
      if (text === lastText) return;
      process.stderr.write(interactive ? `${CLEAR_LINE}${text}` : `${text}\n`);
      lastText = text;
    },

    end() {
      if (interactive && lastText !== undefined) process.stderr.write('\n');
    },
  };
}
