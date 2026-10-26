import { stripVTControlCharacters } from 'node:util';
import { supportsColor } from './terminal';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const wide =
  /[\p{Emoji_Presentation}\u{FE0F}\u{1100}-\u{115F}\u{2329}-\u{232A}\u{2E80}-\u{303E}\u{3041}-\u{33FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{A000}-\u{A4CF}\u{A960}-\u{A97C}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE10}-\u{FE19}\u{FE30}-\u{FE4F}\u{FE50}-\u{FE6B}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1B000}-\u{1B001}\u{1F200}-\u{1F24F}\u{20000}-\u{3FFFD}]/u;
const zeroWidth = /^[\p{Cc}\p{Cf}\p{Mn}\p{Me}]+$/u;

/** Terminal columns a string occupies, ignoring ANSI escapes. */
function stringWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(stripVTControlCharacters(text))) {
    if (zeroWidth.test(segment)) continue;
    width += wide.test(segment) ? 2 : 1;
  }
  return width;
}

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
  if (!supportsColor(stderr)) return message;
  let result = message.replace(
    highlights.title,
    `\x1b[1;36m${highlights.title}\x1b[0m`
  );
  for (const command of highlights.commands) {
    result = result.replace(command, `\x1b[36m${command}\x1b[0m`);
  }
  return result.replace(highlights.url, `\x1b[36;4m${highlights.url}\x1b[0m`);
}
