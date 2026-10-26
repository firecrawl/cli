import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureWebDefaults } from '../../utils/web-defaults';

const originalHome = process.env.HOME;
let tempHome: string;

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.join(tempHome, relativePath), 'utf8');
}

async function write(relativePath: string, content: string): Promise<void> {
  const filePath = path.join(tempHome, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

describe('configureWebDefaults', () => {
  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'firecrawl-web-'));
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('disables native Claude Code and Codex web tools', async () => {
    const results = await configureWebDefaults();

    expect(results.map((result) => result.changed)).toEqual([true, true]);
    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({
      permissions: {
        deny: ['WebSearch', 'WebFetch'],
      },
    });
    expect(await read('.codex/config.toml')).toBe('web_search = "disabled"\n');
  });

  it('preserves existing Claude permissions and Codex config while disabling web', async () => {
    await write(
      '.claude/settings.json',
      JSON.stringify({
        permissions: {
          allow: ['Read'],
          deny: ['Bash(rm *)', 'WebSearch'],
        },
      })
    );
    await write(
      '.codex/config.toml',
      'model = "gpt-5"\nweb_search = "cached"\n'
    );

    await configureWebDefaults();

    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({
      permissions: {
        allow: ['Read'],
        deny: ['Bash(rm *)', 'WebSearch', 'WebFetch'],
      },
    });
    expect(await read('.codex/config.toml')).toBe(
      'model = "gpt-5"\nweb_search = "disabled"\n'
    );
  });

  it('undoes only the native web defaults', async () => {
    await write(
      '.claude/settings.json',
      JSON.stringify({
        permissions: {
          deny: ['Bash(rm *)', 'WebSearch', 'WebFetch'],
        },
      })
    );
    await write(
      '.codex/config.toml',
      'model = "gpt-5"\nweb_search = "disabled"\n'
    );

    const results = await configureWebDefaults({ undo: true });

    expect(results.map((result) => result.changed)).toEqual([true, true]);
    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({
      permissions: {
        deny: ['Bash(rm *)'],
      },
    });
    expect(await read('.codex/config.toml')).toBe('model = "gpt-5"\n');
  });

  it('writes Codex web_search at the root before TOML tables', async () => {
    await write(
      '.codex/config.toml',
      'model = "gpt-5"\n\n[mcp_servers.firecrawl]\ncommand = "npx"\n'
    );

    await configureWebDefaults();

    expect(await read('.codex/config.toml')).toBe(
      'model = "gpt-5"\n\nweb_search = "disabled"\n[mcp_servers.firecrawl]\ncommand = "npx"\n'
    );
  });

  it('does not undo table-local Codex web_search settings', async () => {
    await write(
      '.codex/config.toml',
      'model = "gpt-5"\n\n[profiles.research]\nweb_search = "disabled"\n'
    );

    await configureWebDefaults({ undo: true });

    expect(await read('.codex/config.toml')).toBe(
      'model = "gpt-5"\n\n[profiles.research]\nweb_search = "disabled"\n'
    );
  });

  it('preserves valid JSON strings containing "//" in Claude settings', async () => {
    await write(
      '.claude/settings.json',
      JSON.stringify({
        permissions: {
          allow: ['Read(//c/Users/dev/repo)'],
        },
      })
    );

    const results = await configureWebDefaults();
    const claudeResult = results.find((r) => r.agent === 'Claude Code');
    expect(claudeResult?.skipped).toBeFalsy();
    expect(claudeResult?.changed).toBe(true);

    const saved = JSON.parse(await read('.claude/settings.json'));
    expect(saved.permissions.allow).toEqual(['Read(//c/Users/dev/repo)']);
    expect(saved.permissions.deny).toEqual(['WebSearch', 'WebFetch']);
  });

  it('parses Claude settings containing JSON comments without corrupting strings with "//"', async () => {
    const jsonWithComments = `// Claude settings\n{\n  /* custom permissions */\n  "permissions": {\n    "allow": ["Read(//c/Users/dev/repo)"]\n  }\n}`;
    await write('.claude/settings.json', jsonWithComments);

    const results = await configureWebDefaults();
    const claudeResult = results.find((r) => r.agent === 'Claude Code');
    expect(claudeResult?.skipped).toBeFalsy();
    expect(claudeResult?.changed).toBe(true);

    const saved = JSON.parse(await read('.claude/settings.json'));
    expect(saved.permissions.allow).toEqual(['Read(//c/Users/dev/repo)']);
    expect(saved.permissions.deny).toEqual(['WebSearch', 'WebFetch']);
  });
});
