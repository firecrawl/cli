import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { createAlexandriaCommand } from './list';
import { requestAlexandria } from './alexandria';
vi.mock('./alexandria', async (original) => ({
  ...(await original<typeof import('./alexandria')>()),
  requestAlexandria: vi.fn(),
}));
vi.mock('../utils/output', () => ({ writeOutput: vi.fn() }));
afterEach(() => {
  process.exitCode = undefined;
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requestAlexandria).mockResolvedValue({
    success: true,
    data: {
      alexandria: [{ data: { level: 'providers', items: [], total: 1 } }],
    },
  } as any);
});
it.each(
  'ai-models apps companies software finance health jobs news people places podcasts government real-estate restaurants shopping social sports skills travel'.split(
    ' '
  )
)('routes %s directly to category discovery', async (category) => {
  await new Command()
    .addCommand(createAlexandriaCommand())
    .parseAsync(['alexandria', category, '--json'], { from: 'user' });
  expect(requestAlexandria).toHaveBeenCalledWith(
    [
      {
        provider: 'firecrawl',
        capability: 'find-tools',
        options: {
          categories: [category],
          level: 'providers',
          limit: 20,
        },
      },
    ],
    expect.anything()
  );
});
it('preserves explicit provider browsing', async () => {
  await new Command()
    .addCommand(createAlexandriaCommand())
    .parseAsync(['alexandria', 'list', 'benzinga', '--json'], { from: 'user' });
  expect(requestAlexandria).toHaveBeenCalledWith(
    [
      {
        provider: 'firecrawl',
        capability: 'find-tools',
        options: { providers: ['benzinga'], level: 'tools', limit: 20 },
      },
    ],
    expect.anything()
  );
});

it('lists compact provider tools before expanding a selected contract', async () => {
  const run = (path: string[]) =>
    new Command()
      .addCommand(createAlexandriaCommand())
      .parseAsync(['alexandria', ...path, '--json'], { from: 'user' });
  await run(['people', 'fullenrich']);
  expect(requestAlexandria).toHaveBeenLastCalledWith(
    [
      {
        provider: 'firecrawl',
        capability: 'find-tools',
        options: {
          categories: ['people'],
          providers: ['fullenrich'],
          level: 'tools',
          limit: 20,
        },
      },
    ],
    expect.anything()
  );
  await run(['people', 'fullenrich', 'people/search']);
  expect(requestAlexandria).toHaveBeenLastCalledWith(
    [
      {
        provider: 'firecrawl',
        capability: 'find-tools',
        options: {
          categories: ['people'],
          providers: ['fullenrich'],
          capabilities: ['people/search'],
          level: 'tools',
          expand: ['options', 'response', 'examples'],
          limit: 20,
        },
      },
    ],
    expect.anything()
  );
});
it('expands category contracts only when requested', async () => {
  await new Command()
    .addCommand(createAlexandriaCommand())
    .parseAsync(['alexandria', 'people', '--contracts', '--json'], {
      from: 'user',
    });
  expect(requestAlexandria).toHaveBeenLastCalledWith(
    [
      {
        provider: 'firecrawl',
        capability: 'find-tools',
        options: {
          categories: ['people'],
          level: 'tools',
          expand: ['options', 'response', 'examples'],
          limit: 20,
        },
      },
    ],
    expect.anything()
  );
});

it('points a search verb under alexandria at search alexandria without a request', async () => {
  const { writeOutput } = await import('../utils/output');
  await new Command()
    .addCommand(createAlexandriaCommand())
    .parseAsync(['alexandria', 'search', '3d model', '--json'], {
      from: 'user',
    });
  expect(requestAlexandria).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  const output = JSON.parse(vi.mocked(writeOutput).mock.calls[0][0]);
  expect(output.error).toContain('is not an Alexandria category');
  expect(output.guidance).toContain("firecrawl search alexandria '3d model'");
});

it('turns an unknown category into commands that work', async () => {
  const { writeOutput } = await import('../utils/output');
  vi.mocked(requestAlexandria).mockResolvedValue({
    success: true,
    data: {
      alexandria: [
        {
          error: {
            code: 'invalid_option',
            message:
              'Unknown or unavailable categories. Browse the catalogue for accessible IDs; use query for natural-language search.',
          },
        },
      ],
    },
  } as any);
  await new Command()
    .addCommand(createAlexandriaCommand())
    .parseAsync(['alexandria', '3d', '--json'], { from: 'user' });
  const output = JSON.parse(vi.mocked(writeOutput).mock.calls[0][0]);
  expect(output.guidance).toContain('firecrawl search alexandria 3d');
  expect(output.guidance).toContain('firecrawl alexandria list --providers');
});
