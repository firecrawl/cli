import stringWidth from 'string-width';

/** Shared presentation for CLI and skill update notices. */
export function formatUpdateBox(lines: readonly string[]): string {
  const width = Math.max(0, ...lines.map((line) => stringWidth(line)));
  const top = `╭${'─'.repeat(width + 2)}╮`;
  const bottom = `╰${'─'.repeat(width + 2)}╯`;
  const body = lines.map(
    (line) => `│ ${line}${' '.repeat(width - stringWidth(line))} │`
  );
  return [top, ...body, bottom].join('\n');
}

export function colorizeUpdateNotice(
  message: string,
  stderr: Pick<NodeJS.WriteStream, 'isTTY'>,
  highlights: { title: string; commands: readonly string[]; url: string }
): string {
  if (process.env.NO_COLOR !== undefined) return message;
  const supportsColor =
    process.env.FORCE_COLOR !== undefined
      ? process.env.FORCE_COLOR !== '0'
      : Boolean(stderr.isTTY);
  if (!supportsColor) return message;
  let result = message.replace(
    highlights.title,
    `\x1b[1;36m${highlights.title}\x1b[0m`
  );
  for (const command of highlights.commands) {
    result = result.replace(command, `\x1b[36m${command}\x1b[0m`);
  }
  return result.replace(highlights.url, `\x1b[36;4m${highlights.url}\x1b[0m`);
}
