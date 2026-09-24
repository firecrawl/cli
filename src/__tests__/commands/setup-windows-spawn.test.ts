import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { runClientCommand } from '../../commands/setup';

// Spawns a real cmd.exe, unlike setup.test.ts which mocks child_process.
describe.runIf(process.platform === 'win32')(
  'runClientCommand on Windows (real cmd.exe)',
  () => {
    it('launches a .cmd shim under a path with spaces and parentheses and passes argv through exactly', () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-spawn-'));
      const bin = path.join(root, 'Program Files (x86)', 'nodejs');
      const outFile = path.join(root, 'argv.json');
      try {
        mkdirSync(bin, { recursive: true });
        writeFileSync(
          path.join(bin, 'record-argv.js'),
          'require("fs").writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n'
        );
        writeFileSync(
          path.join(bin, 'record-argv.cmd'),
          '@echo off\r\nnode "%~dp0record-argv.js" %*\r\n'
        );
        const args = [
          '--name',
          'firecrawl',
          'https://mcp.firecrawl.dev/v2/mcp?a=1&b=2',
          'Authorization: Bearer ${FIRECRAWL_API_KEY}',
        ];

        runClientCommand(path.join(bin, 'record-argv.cmd'), args, {
          stdio: 'pipe',
          env: { ...process.env, ARGV_OUT: outFile },
        });

        expect(JSON.parse(readFileSync(outFile, 'utf8'))).toEqual(args);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
);
