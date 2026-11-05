import * as readline from 'readline';

type PipedInput = {
  input: NodeJS.ReadableStream;
  rl: readline.Interface;
  lines: string[];
  waiters: Array<(line: string | null) => void>;
  closed: boolean;
};

let piped: PipedInput | undefined;

/**
 * Next line of non-terminal stdin. One reader serves every prompt, so a pipe
 * that answers several prompts (`printf '2\nfc-...\n'`) keeps its later lines.
 * Resolves null once stdin has ended.
 */
function nextPipedLine(): Promise<string | null> {
  if (!piped || piped.input !== process.stdin) {
    const state: PipedInput = {
      input: process.stdin,
      rl: readline.createInterface({ input: process.stdin }),
      lines: [],
      waiters: [],
      closed: false,
    };
    state.rl.on('line', (line) => {
      const waiter = state.waiters.shift();
      if (waiter) waiter(line);
      else state.lines.push(line);
      if (!state.waiters.length) {
        state.rl.pause();
        (state.input as { unref?: () => void }).unref?.();
      }
    });
    state.rl.on('close', () => {
      state.closed = true;
      for (const waiter of state.waiters.splice(0)) waiter(null);
    });
    piped = state;
  }
  const state = piped;
  const buffered = state.lines.shift();
  if (buffered !== undefined) return Promise.resolve(buffered);
  if (state.closed) return Promise.resolve(null);
  return new Promise((resolve) => {
    state.waiters.push(resolve);
    (state.input as { ref?: () => void }).ref?.();
    state.rl.resume();
  });
}

/**
 * Prompt for one line of input. Rejects when stdin ends before an answer (CI,
 * agents, `</dev/null`, Ctrl+D), so callers fail instead of the process
 * exiting 0 mid-prompt. Ctrl+C exits 130.
 */
export function promptInput(
  question: string,
  noInputMessage: string
): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
    return nextPipedLine().then((line) => {
      if (line === null) throw new Error(noInputMessage);
      return line.trim();
    });
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve, reject) => {
    let answered = false;
    rl.on('SIGINT', () => {
      rl.close();
      process.exit(130);
    });
    rl.on('close', () => {
      if (!answered) reject(new Error(noInputMessage));
    });
    rl.question(question, (answer: string) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}
