import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { addFormatsAlias } from '../../utils/format-option';

describe('format compatibility alias', () => {
  it.each([
    [['--formats', 'markdown,links'], 'markdown,links'],
    [['--formats=markdown,links'], 'markdown,links'],
    [['--formats', 'html', '--format', 'markdown'], 'markdown'],
    [['--format', 'html', '--formats', 'markdown'], 'markdown'],
    [['--formats', 'html', '-f', 'markdown'], 'markdown'],
    [['-f', 'html', '--formats', 'markdown'], 'markdown'],
  ])('normalizes %j to the canonical format', (args, expected) => {
    const command = addFormatsAlias(
      new Command().option('-f, --format <formats>', 'Output formats')
    );
    command.parse(args, { from: 'user' });
    expect(command.opts().format).toBe(expected);
    expect(command.getOptionValueSource('format')).toBe('cli');
  });
});
