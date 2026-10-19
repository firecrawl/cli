import * as readline from 'readline';

/**
 * Prompt for one line of input. Rejects with `noInputMessage` when stdin ends
 * before an answer (CI, agents, `</dev/null`, Ctrl+D), so callers fail instead
 * of the process exiting 0 mid-prompt. Ctrl+C exits 130.
 * readline drops an unterminated last line, so piped input is read from stdin
 * directly; a terminal's buffer may hold erased keystrokes, so it never is.
 */
export function promptInput(
  question: string,
  noInputMessage: string
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve, reject) => {
    let answered = false;
    let unterminated = '';
    const onData = (chunk: Buffer | string): void => {
      const text = unterminated + chunk.toString();
      unterminated = text.slice(text.search(/[^\r\n]*$/));
    };
    if (!process.stdin.isTTY) process.stdin.on('data', onData);
    rl.on('SIGINT', () => {
      rl.close();
      process.exit(130);
    });
    rl.on('close', () => {
      process.stdin.off('data', onData);
      if (answered) return;
      const answer = unterminated.trim();
      if (answer) resolve(answer);
      else reject(new Error(noInputMessage));
    });
    rl.question(question, (answer: string) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}
