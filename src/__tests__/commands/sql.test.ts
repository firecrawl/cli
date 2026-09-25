import { afterEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqlCommand, readSqlInput } from '../../commands/sql';
import { handleAlexandria } from '../../commands/alexandria';

vi.mock('../../commands/alexandria', () => ({ handleAlexandria: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it.each([false, true])('forwards raw SQL with execute=%s', async (execute) => {
  const query = 'SELECT * FROM "example/tool" WHERE name = \'Nike\' LIMIT 1';
  await createSqlCommand().parseAsync(
    [
      query,
      ...(execute ? ['--execute'] : []),
      '--pretty',
      '--request-id',
      'request',
    ],
    { from: 'user' }
  );
  expect(handleAlexandria).toHaveBeenCalledWith(
    [{ provider: 'firecrawl', capability: 'sql', options: { query, execute } }],
    expect.objectContaining({ pretty: true, requestId: 'request' })
  );
});

it('reads multiline stdin without changing quotes', async () => {
  const query =
    'WITH a AS (\n SELECT * FROM "a/b" LIMIT 1\n) SELECT * FROM a LIMIT 1';
  expect(await readSqlInput(undefined, undefined, Readable.from([query]))).toBe(
    query
  );
});

it('reads a file and forwards it to the existing handler', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sql-cli-'));
  try {
    const path = join(dir, 'query.sql');
    await writeFile(path, 'SHOW TABLES LIMIT 1');
    await createSqlCommand().parseAsync(['--file', path], { from: 'user' });
    expect(handleAlexandria).toHaveBeenCalledWith(
      [
        {
          provider: 'firecrawl',
          capability: 'sql',
          options: { query: 'SHOW TABLES LIMIT 1', execute: false },
        },
      ],
      expect.anything()
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects ambiguous sources without dispatch', async () => {
  await expect(
    createSqlCommand().parseAsync(['HELP', '--file', 'query.sql'], {
      from: 'user',
    })
  ).rejects.toThrow('either');
  expect(handleAlexandria).not.toHaveBeenCalled();
});

it('rejects missing, empty and oversized input', async () => {
  await expect(
    readSqlInput(
      undefined,
      undefined,
      Object.assign(Readable.from([]), { isTTY: true })
    )
  ).rejects.toThrow('Provide');
  await expect(
    readSqlInput(undefined, undefined, Readable.from([' ']))
  ).rejects.toThrow('empty');
  await expect(readSqlInput('x'.repeat(16001), undefined)).rejects.toThrow(
    '16,000'
  );
  await expect(
    readSqlInput(undefined, undefined, Readable.from(['x'.repeat(16001)]))
  ).rejects.toThrow('16,000');
});
