import { existsSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTOML } from 'toml-eslint-parser';
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

    const results = await configureWebDefaults();

    expect(JSON.parse(await read('.claude/settings.json'))).toEqual({
      permissions: {
        allow: ['Read'],
        deny: ['Bash(rm *)', 'WebSearch', 'WebFetch'],
      },
    });
    // The user chose this value. Report it, never overwrite it.
    expect(await read('.codex/config.toml')).toBe(
      'model = "gpt-5"\nweb_search = "cached"\n'
    );
    const codex = results.find((result) => result.agent === 'Codex');
    expect(codex?.changed).toBe(false);
    expect(codex?.preserved).toBe(true);
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
      'model = "gpt-5"\nweb_search = "disabled"\n\n[mcp_servers.firecrawl]\ncommand = "npx"\n'
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

  it('never overwrites a web_search the user turned on, comment and all', async () => {
    const original =
      '# my codex config\nweb_search = "enabled"   # I deliberately want this ON\nmodel = "gpt-5"\n';
    await write('.codex/config.toml', original);

    const results = await configureWebDefaults();

    expect(await read('.codex/config.toml')).toBe(original);
    const codex = results.find((result) => result.agent === 'Codex');
    expect(codex?.preserved).toBe(true);
    expect(codex?.message).toContain('enabled');
  });

  it('treats an unspaced web_search="disabled" as already done', async () => {
    await write('.codex/config.toml', 'web_search="disabled"\n');

    const results = await configureWebDefaults();

    expect(await read('.codex/config.toml')).toBe('web_search="disabled"\n');
    expect(results.find((result) => result.agent === 'Codex')?.changed).toBe(
      false
    );
  });

  it('keeps comments in Claude settings.json', async () => {
    await write(
      '.claude/settings.json',
      '{\n  // keep me\n  "model": "opus",\n  "permissions": { "deny": ["Bash(rm *)"] }\n}\n'
    );

    await configureWebDefaults();

    const written = await read('.claude/settings.json');
    expect(written).toContain('// keep me');
    expect(written).toContain('WebSearch');
    expect(written).toContain('Bash(rm *)');
  });

  it('reports the exact edit without writing when dryRun is set', async () => {
    await write('.codex/config.toml', 'model = "gpt-5"\n');

    const results = await configureWebDefaults({ dryRun: true });

    expect(await read('.codex/config.toml')).toBe('model = "gpt-5"\n');
    const codex = results.find((result) => result.agent === 'Codex');
    expect(codex?.changed).toBe(true);
    expect(codex?.preview).toBe('+ web_search = "disabled"');
    const claude = results.find((result) => result.agent === 'Claude Code');
    expect(claude?.preview).toBe(
      'permissions.deny += ["WebSearch","WebFetch"]'
    );
  });

  it('skips a Codex config it cannot parse instead of rewriting it', async () => {
    const broken = 'model = "gpt-5"\nthis is not = = valid toml\n';
    await write('.codex/config.toml', broken);

    const results = await configureWebDefaults();

    expect(await read('.codex/config.toml')).toBe(broken);
    expect(results.find((result) => result.agent === 'Codex')?.skipped).toBe(
      true
    );
  });

  it('leaves a user-chosen web_search alone on undo', async () => {
    const original = 'web_search = "cached"\n';
    await write('.codex/config.toml', original);

    const results = await configureWebDefaults({ undo: true });

    expect(await read('.codex/config.toml')).toBe(original);
    expect(results.find((result) => result.agent === 'Codex')?.changed).toBe(
      false
    );
  });

  it('does not splice into a multi-line root value', async () => {
    await write(
      '.codex/config.toml',
      'model = "gpt-5"\nnotify = [\n  "notify-send",\n  "Codex",\n]\n'
    );

    await configureWebDefaults({ agents: ['Codex'] });

    const written = await read('.codex/config.toml');
    expect(() => parseTOML(written)).not.toThrow();
    expect(written).toContain('  "notify-send",\n  "Codex",\n]');
    expect(written).toMatch(/^web_search = "disabled"$/m);
  });

  it('keeps a multi-line string value intact', async () => {
    await write(
      '.codex/config.toml',
      'instructions = """\nline one\nline two\n"""\n'
    );

    await configureWebDefaults({ agents: ['Codex'] });

    const written = await read('.codex/config.toml');
    expect(() => parseTOML(written)).not.toThrow();
    expect(written).toContain('line one\nline two');
    expect(written).toMatch(/^web_search = "disabled"$/m);
  });

  it.each(['null', '[]', '"nope"'])(
    'replaces a permissions value of %s instead of throwing',
    async (shape) => {
      await write('.claude/settings.json', `{ "permissions": ${shape} }`);

      await configureWebDefaults({ agents: ['Claude Code'] });

      expect(
        JSON.parse(await read('.claude/settings.json')).permissions.deny
      ).toEqual(['WebSearch', 'WebFetch']);
    }
  );

  it('follows CODEX_HOME and CLAUDE_CONFIG_DIR like the MCP writer', async () => {
    process.env.CODEX_HOME = path.join(tempHome, 'work', '.codex');
    process.env.CLAUDE_CONFIG_DIR = path.join(tempHome, 'work', '.claude');
    try {
      await configureWebDefaults();

      expect(await read('work/.codex/config.toml')).toContain(
        'web_search = "disabled"'
      );
      expect(
        JSON.parse(await read('work/.claude/settings.json')).permissions.deny
      ).toEqual(['WebSearch', 'WebFetch']);
      // The un-overridden locations are files the agent never reads.
      expect(existsSync(path.join(tempHome, '.codex'))).toBe(false);
      expect(existsSync(path.join(tempHome, '.claude'))).toBe(false);
    } finally {
      delete process.env.CODEX_HOME;
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
});
