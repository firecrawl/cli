/**
 * Simple spinner utility for CLI feedback
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface Spinner {
  start: (message?: string) => void;
  update: (message: string) => void;
  stop: (finalMessage?: string) => void;
  succeed: (message?: string) => void;
  fail: (message?: string) => void;
}

export function createSpinner(initialMessage: string = ''): Spinner {
  let frameIndex = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentMessage = initialMessage;

  const clearLine = () => {
    process.stderr.write('\r\x1b[K');
  };

  const render = () => {
    const frame = SPINNER_FRAMES[frameIndex];
    clearLine();
    process.stderr.write(`${frame} ${currentMessage}`);
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
  };

  return {
    start(message?: string) {
      if (message) currentMessage = message;
      if (interval) return;
      render();
      interval = setInterval(render, 80);
    },

    update(message: string) {
      currentMessage = message;
    },

    stop(finalMessage?: string) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      clearLine();
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
