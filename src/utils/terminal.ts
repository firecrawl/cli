type Stream = Pick<NodeJS.WriteStream, 'isTTY'>;

/** True when the stream is a terminal that can redraw a line in place. */
export function isInteractive(stream: Stream): boolean {
  return Boolean(stream.isTTY) && process.env.TERM !== 'dumb';
}

/** NO_COLOR wins over FORCE_COLOR; otherwise only interactive streams get color. */
export function supportsColor(stream: Stream): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) {
    return process.env.FORCE_COLOR !== '0';
  }
  return isInteractive(stream);
}

const colorEnabled = supportsColor(process.stdout);
const sgr = (code: string): string => (colorEnabled ? `\x1b[${code}m` : '');

export const reset = sgr('0');
export const bold = sgr('1');
export const dim = sgr('2');
export const red = sgr('31');
export const green = sgr('32');
export const yellow = sgr('33');
export const cyan = sgr('36');
export const orange = sgr('38;5;208');
