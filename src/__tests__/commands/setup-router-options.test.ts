import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { addSetupRouterOptions } from '../../commands/setup';

function parse(...argv: string[]): Record<string, unknown> {
  const command = addSetupRouterOptions(
    new Command().exitOverride().option('--agent <agent>')
  );
  command.parse(argv, { from: 'user' });
  return command.opts();
}

describe('setup MCP router option parsing', () => {
  it.each([
    [[], undefined],
    [['--router-card'], true],
    [['--no-router-card'], false],
    [['--router-card', '--no-router-card'], false],
    [['--no-router-card', '--router-card'], true],
  ])('uses Commander last-option semantics for %j', (argv, expected) => {
    expect(parse(...(argv as string[])).routerCard).toBe(expected);
  });

  it.each([['--router-card'], ['--no-router-card']])(
    'rejects removal with %s',
    (routerOption) => {
      expect(() => parse(routerOption, '--remove-router-card')).toThrow(
        'cannot be used with option'
      );
    }
  );

  it('parses explicit project-scoped removal', () => {
    expect(
      parse(
        '--agent',
        'codex',
        '--project',
        '/workspace',
        '--remove-router-card'
      )
    ).toMatchObject({
      agent: 'codex',
      project: '/workspace',
      removeRouterCard: true,
    });
  });
});
