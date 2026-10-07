import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { handleAlexandria } from './alexandria';

export async function readSqlInput(
  query: string | undefined,
  file: string | undefined,
  stdin: AsyncIterable<string | Buffer> & { isTTY?: boolean } = process.stdin
): Promise<string> {
  if (query !== undefined && file !== undefined)
    throw new Error('Use either a query or --file.');
  if (file !== undefined) query = await readFile(file, 'utf8');
  if (query === undefined) {
    if (stdin.isTTY) throw new Error('Provide a query, --file, or stdin.');
    query = '';
    for await (const chunk of stdin) {
      query += chunk.toString();
      if (query.length > 16000)
        throw new Error('SQL must be at most 16,000 characters.');
    }
  }
  if (!query.trim()) throw new Error('SQL must not be empty.');
  if (query.length > 16000)
    throw new Error('SQL must be at most 16,000 characters.');
  return query;
}

export function createSqlCommand(): Command {
  return new Command('sql')
    .description('Experimental Alexandria syntax')
    .argument('[query]', 'SQL statement')
    .option('-f, --file <path>', 'Read SQL from a file')
    .option(
      '--execute',
      'Execute paid provider calls; defaults to preview',
      false
    )
    .option('-k, --api-key <key>', 'Firecrawl API key')
    .option('--api-url <url>', 'Firecrawl API URL')
    .option('--request-id <id>', 'Request ID')
    .option('-o, --output <path>', 'Output file')
    .option('--json', 'Output JSON')
    .option('--pretty', 'Format JSON')
    .action(async (query, options) => {
      const statement = await readSqlInput(query, options.file);
      await handleAlexandria(
        [
          {
            provider: 'firecrawl',
            capability: 'sql',
            options: { query: statement, execute: options.execute },
          },
        ],
        options
      );
    });
}
