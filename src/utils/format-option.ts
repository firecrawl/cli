import { Command } from 'commander';

export function addFormatsAlias(command: Command): Command {
  return command
    .option(
      '--formats <formats>',
      'Alias for --format; the last occurrence wins'
    )
    .on('option:formats', (value: string) => {
      command.setOptionValueWithSource('format', value, 'cli');
    });
}
