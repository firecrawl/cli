import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import {
  detectMcpClients,
  resolveMcpClientId,
  type McpContext,
} from '../../utils/mcp-clients';
import { parse as parseYaml } from 'yaml';
import {
  appendRuleSection,
  setupMcpClient,
  upsertTomlServer,
  upsertYamlServer,
  writeJsonServerEntry,
} from '../../utils/mcp-install';

const MCP_URL = 'https://mcp.firecrawl.dev/v2/mcp';

describe('mcp install', () => {
  let root: string;
  let ctx: McpContext;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'firecrawl-mcp-engine-'));
    mkdirSync(path.join(root, 'proj'), { recursive: true });
    ctx = {
      home: path.join(root, 'home'),
      cwd: path.join(root, 'proj'),
      platform: 'darwin',
      env: {},
      auth: 'keyless',
    };
    mkdirSync(ctx.home, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const read = (...parts: string[]) =>
    readFileSync(path.join(...parts), 'utf-8');

  describe('writeJsonServerEntry', () => {
    it('creates the file and its parent directory when missing', async () => {
      const file = path.join(root, 'nested', 'mcp.json');

      const { status } = await writeJsonServerEntry(file, 'mcpServers', 'fc', {
        url: MCP_URL,
      });

      expect(status).toBe('configured');
      expect(JSON.parse(read(file))).toEqual({
        mcpServers: { fc: { url: MCP_URL } },
      });
    });

    it('preserves comments and unrelated keys in an existing JSONC config', async () => {
      const file = path.join(root, 'settings.json');
      writeFileSync(
        file,
        [
          '// editor settings',
          '{',
          '  "theme": "One Dark",',
          '  // keep me',
          '  "buffer_font_size": 15,',
          '  "servers": { "other": { "url": "https://example.com" } }',
          '}',
          '',
        ].join('\n')
      );

      await writeJsonServerEntry(file, 'servers', 'fc', { url: MCP_URL });

      const result = read(file);
      expect(result).toContain('// editor settings');
      expect(result).toContain('// keep me');
      expect(result).toContain('"theme": "One Dark"');
      expect(result).toContain('"other"');
      expect(result).toContain(MCP_URL);
    });

    it('accepts a config that starts with a byte order mark', async () => {
      const file = path.join(root, 'bom.json');
      writeFileSync(
        file,
        '\uFEFF{ "mcpServers": { "own": { "url": "https://x" } } }'
      );

      const { status } = await writeJsonServerEntry(file, 'mcpServers', 'fc', {
        url: MCP_URL,
      });

      const result = read(file);
      expect(status).toBe('configured');
      expect(result.startsWith('\uFEFF')).toBe(true);
      expect(result).toContain('"own"');
      expect(result).toContain(MCP_URL);
    });

    it('reports reconfigured when the server is already present', async () => {
      const file = path.join(root, 'mcp.json');
      writeFileSync(
        file,
        JSON.stringify({ mcpServers: { fc: { url: 'https://old' } } })
      );

      const { status } = await writeJsonServerEntry(file, 'mcpServers', 'fc', {
        url: MCP_URL,
      });

      expect(status).toBe('reconfigured');
      expect(JSON.parse(read(file)).mcpServers.fc.url).toBe(MCP_URL);
    });

    it('replaces the servers key when it holds a non-object', async () => {
      const file = path.join(root, 'mcp.json');
      writeFileSync(file, JSON.stringify({ mcpServers: 'nonsense' }));

      const { status } = await writeJsonServerEntry(file, 'mcpServers', 'fc', {
        url: MCP_URL,
      });

      expect(status).toBe('configured');
      expect(JSON.parse(read(file)).mcpServers.fc.url).toBe(MCP_URL);
    });

    it('refuses to overwrite a config it cannot parse', async () => {
      const file = path.join(root, 'mcp.json');
      const broken = '{ "mcpServers": { oops\n';
      writeFileSync(file, broken);

      await expect(
        writeJsonServerEntry(file, 'mcpServers', 'fc', { url: MCP_URL })
      ).rejects.toThrow('could not parse existing config');
      expect(read(file)).toBe(broken);
    });
  });

  describe('upsertTomlServer', () => {
    it('appends after root keys when the server is absent', () => {
      const { content, alreadyExists } = upsertTomlServer(
        'model = "gpt-5"\n',
        'firecrawl',
        { url: MCP_URL }
      );

      expect(alreadyExists).toBe(false);
      expect(content).toBe(
        `model = "gpt-5"\n\n[mcp_servers.firecrawl]\nurl = "${MCP_URL}"\n`
      );
    });

    it('replaces a stale stdio entry along with its sub-tables', () => {
      const existing = [
        'model = "gpt-5"',
        '',
        '[mcp_servers.firecrawl]',
        'command = "npx"',
        'args = ["-y", "firecrawl-mcp"]',
        '',
        '[mcp_servers.firecrawl.env]',
        'FIRECRAWL_API_KEY = "fc-old"',
        '',
        '[mcp_servers.other]',
        'url = "https://example.com/mcp"',
        '',
      ].join('\n');

      const { content, alreadyExists } = upsertTomlServer(
        existing,
        'firecrawl',
        { url: MCP_URL }
      );

      expect(alreadyExists).toBe(true);
      expect(content).not.toContain('firecrawl-mcp');
      expect(content).not.toContain('fc-old');
      expect(content).not.toContain('mcp_servers.firecrawl.env');
      expect(content).toContain('[mcp_servers.other]');
      expect(content).toContain('model = "gpt-5"');
      expect(content).toContain(`url = "${MCP_URL}"`);
    });

    it('matches an existing table in a CRLF file instead of duplicating it', () => {
      const crlf =
        'model = "gpt-5"\r\n\r\n[mcp_servers.firecrawl]\r\nurl = "https://old"\r\n';

      const { content, alreadyExists } = upsertTomlServer(crlf, 'firecrawl', {
        url: MCP_URL,
      });

      expect(alreadyExists).toBe(true);
      expect(content.match(/\[mcp_servers\.firecrawl\]/g)).toHaveLength(1);
      expect(content).toContain('\r\n');
      expect(
        upsertTomlServer(content, 'firecrawl', { url: MCP_URL }).content
      ).toBe(content);
    });

    it('keeps comments that introduce the following table', () => {
      const existing = [
        '[mcp_servers.firecrawl]',
        'url = "https://old"',
        '',
        '# notes about the next server',
        '[mcp_servers.other]',
        'url = "https://example.com/mcp"',
        '',
      ].join('\n');

      const { content } = upsertTomlServer(existing, 'firecrawl', {
        url: MCP_URL,
      });

      expect(content).toContain('# notes about the next server');
      expect(content).toContain('[mcp_servers.other]');
    });

    it('is stable across repeated writes', () => {
      const first = upsertTomlServer('', 'firecrawl', { url: MCP_URL }).content;
      const second = upsertTomlServer(first, 'firecrawl', {
        url: MCP_URL,
      }).content;

      expect(second).toBe(first);
    });

    it('ignores table syntax written inside a multi-line string', () => {
      const existing = [
        'instructions = """',
        '[mcp_servers.firecrawl]',
        'url = "https://not-a-table"',
        '"""',
        '',
      ].join('\n');

      const { content, alreadyExists } = upsertTomlServer(
        existing,
        'firecrawl',
        { url: MCP_URL }
      );

      // The string keeps its contents and the real table is appended after it.
      expect(alreadyExists).toBe(false);
      expect(content).toContain('url = "https://not-a-table"');
      expect(content).toMatch(
        new RegExp(`\\[mcp_servers\\.firecrawl\\]\\nurl = ".*"\\n$`)
      );
    });

    it('does not end a basic string on an escaped fence', () => {
      const existing = [
        'instructions = """',
        String.raw`he said \""" loudly`,
        '[mcp_servers.firecrawl]',
        'url = "https://not-a-table"',
        '"""',
        '',
      ].join('\n');

      const { content, alreadyExists } = upsertTomlServer(
        existing,
        'firecrawl',
        { url: MCP_URL }
      );

      // Everything above stays string content, so nothing in it is replaced.
      expect(alreadyExists).toBe(false);
      expect(content).toContain(String.raw`he said \""" loudly`);
      expect(content).toContain('url = "https://not-a-table"');
      expect(content).toMatch(
        new RegExp(`\\[mcp_servers\\.firecrawl\\]\\nurl = "${MCP_URL}"\\n$`)
      );
    });

    it('closes a basic string when the fence follows an escaped backslash', () => {
      const existing = [
        'instructions = """',
        String.raw`trailing slash \\"""`,
        '[mcp_servers.firecrawl]',
        'url = "https://old"',
        '',
      ].join('\n');

      const { content, alreadyExists } = upsertTomlServer(
        existing,
        'firecrawl',
        { url: MCP_URL }
      );

      // The run of backslashes is even, so the fence really does terminate and
      // the table below it is a real one to replace.
      expect(alreadyExists).toBe(true);
      expect(content).toContain(`url = "${MCP_URL}"`);
      expect(content).not.toContain('https://old');
    });

    it('refuses a config whose multi-line string is never closed', () => {
      expect(() =>
        upsertTomlServer('instructions = """\nstill open\n', 'firecrawl', {
          url: MCP_URL,
        })
      ).toThrow('unterminated multi-line string');
    });
  });

  describe('upsertYamlServer', () => {
    it('keeps the comments and formatting around an added server', () => {
      const existing = [
        '# Hermes configuration',
        'model: anthropic/claude-opus-4.6 # my preferred model',
        '',
        'mcp_servers:',
        '  github:',
        '    command: npx',
        '',
      ].join('\n');

      const { content, alreadyExists } = upsertYamlServer(
        existing,
        'mcp_servers',
        'firecrawl',
        { url: MCP_URL }
      );

      expect(alreadyExists).toBe(false);
      expect(content).toContain('# Hermes configuration');
      expect(content).toContain('# my preferred model');
      expect(content).toContain('command: npx');
      expect(content).toContain(`url: ${MCP_URL}`);
    });

    it('builds the server map when the file is empty', () => {
      const { content, alreadyExists } = upsertYamlServer(
        '',
        'mcp_servers',
        'firecrawl',
        { url: MCP_URL }
      );

      expect(alreadyExists).toBe(false);
      expect(parseYaml(content)).toEqual({
        mcp_servers: { firecrawl: { url: MCP_URL } },
      });
    });

    it('reports an existing entry as already present and replaces it', () => {
      const existing = 'mcp_servers:\n  firecrawl:\n    url: https://old\n';

      const { content, alreadyExists } = upsertYamlServer(
        existing,
        'mcp_servers',
        'firecrawl',
        { url: MCP_URL }
      );

      expect(alreadyExists).toBe(true);
      expect(content).toContain(MCP_URL);
      expect(content).not.toContain('https://old');
    });

    it('fills in a server section that exists but is empty', () => {
      const { content, alreadyExists } = upsertYamlServer(
        'model: opus\nmcp_servers:\n',
        'mcp_servers',
        'firecrawl',
        { url: MCP_URL }
      );

      expect(alreadyExists).toBe(false);
      expect(parseYaml(content)).toEqual({
        model: 'opus',
        mcp_servers: { firecrawl: { url: MCP_URL } },
      });
    });

    it('keeps a comment that sat on the empty section', () => {
      const { content } = upsertYamlServer(
        'model: opus\nmcp_servers: # servers live here\n',
        'mcp_servers',
        'firecrawl',
        { url: MCP_URL }
      );

      expect(content).toContain('# servers live here');
      expect(parseYaml(content)).toEqual({
        model: 'opus',
        mcp_servers: { firecrawl: { url: MCP_URL } },
      });
    });

    it('keeps a byte order mark and CRLF line endings', () => {
      const existing =
        '\uFEFFmodel: opus\r\nterminal:\r\n  backend: docker\r\n';

      const { content } = upsertYamlServer(
        existing,
        'mcp_servers',
        'firecrawl',
        { url: MCP_URL }
      );

      expect(content.startsWith('\uFEFF')).toBe(true);
      expect(content).toContain('\r\n');
      expect(/[^\r]\n/.test(content)).toBe(false);
      expect(parseYaml(content.slice(1))).toMatchObject({
        model: 'opus',
        mcp_servers: { firecrawl: { url: MCP_URL } },
      });
    });

    it('refuses a config that does not parse', () => {
      expect(() =>
        upsertYamlServer(
          'model: "unterminated\nother: 1\n',
          'mcp_servers',
          'firecrawl',
          { url: MCP_URL }
        )
      ).toThrow(/quote/i);
    });
  });

  describe('appendRuleSection', () => {
    it('keeps existing content and replaces only the fenced section', async () => {
      const file = path.join(root, 'AGENTS.md');
      writeFileSync(file, '# My project\n\nRun tests with pnpm test.\n');

      expect(await appendRuleSection(file, 'first\n')).toBe('installed');
      expect(await appendRuleSection(file, 'second\n')).toBe('updated');

      const result = read(file);
      expect(result).toContain('# My project');
      expect(result).toContain('Run tests with pnpm test.');
      expect(result).toContain('second');
      expect(result).not.toContain('first');
      expect(result.match(/<!-- firecrawl -->/g)).toHaveLength(2);
    });
  });

  describe('appendRuleSection line endings', () => {
    it('replaces its section after the file is converted to CRLF', async () => {
      const file = path.join(root, 'AGENTS.md');

      expect(await appendRuleSection(file, 'first\n')).toBe('installed');
      writeFileSync(file, read(file).replace(/\n/g, '\r\n'));

      expect(await appendRuleSection(file, 'second\n')).toBe('updated');
      const result = read(file);
      expect(result.match(/<!-- firecrawl -->/g)).toHaveLength(2);
      expect(result).not.toContain('first');
    });
  });

  it('keeps the line endings of a CRLF rule file', async () => {
    const file = path.join(root, 'AGENTS.md');
    writeFileSync(file, '# Title\r\n\r\nBody line.\r\n');

    await appendRuleSection(file, 'RULE ONE\nRULE TWO\n');

    const written = read(file);
    expect(written).toContain('\r\n');
    expect(/[^\r]\n/.test(written)).toBe(false);
    expect(written).toContain('Body line.');
  });

  describe('setupMcpClient', () => {
    it('writes the keyless URL with no credentials', async () => {
      const result = await setupMcpClient('cursor', {
        rules: false,
        ctx,
      });

      expect(result.mcpStatus).toBe('configured');
      expect(result.ruleStatus).toBe('skipped');
      expect(
        JSON.parse(read(ctx.home, '.cursor', 'mcp.json')).mcpServers.firecrawl
      ).toEqual({ url: MCP_URL });
    });

    it('references the env var instead of writing a credential', async () => {
      const result = await setupMcpClient('claude', {
        rules: false,
        ctx: { ...ctx, auth: 'env' },
      });

      expect(result.mcpStatus).toBe('configured');
      expect(result.auth).toBe('env');
      expect(
        JSON.parse(read(ctx.home, '.claude.json')).mcpServers.firecrawl
      ).toEqual({
        type: 'http',
        url: MCP_URL,
        headers: { Authorization: 'Bearer ${FIRECRAWL_API_KEY}' },
      });
    });

    it('honours CLAUDE_CONFIG_DIR', async () => {
      const configDir = path.join(root, 'claude-config');
      const result = await setupMcpClient('claude', {
        rules: true,
        ctx: { ...ctx, env: { CLAUDE_CONFIG_DIR: configDir } },
      });

      expect(result.mcpDetail).toBe(path.join(configDir, '.claude.json'));
      expect(result.ruleDetail).toBe(
        path.join(configDir, 'rules', 'firecrawl.md')
      );
    });

    it('uses the environment-reference syntax each agent expands', async () => {
      const written: Record<string, unknown> = {};
      for (const id of ['cursor', 'vscode', 'opencode'] as const) {
        const result = await setupMcpClient(id, {
          rules: false,
          ctx: { ...ctx, auth: 'env' },
        });
        written[id] = JSON.parse(read(result.mcpDetail));
      }

      expect((written.cursor as any).mcpServers.firecrawl.headers).toEqual({
        Authorization: 'Bearer ${env:FIRECRAWL_API_KEY}',
      });
      expect((written.vscode as any).servers.firecrawl.headers).toEqual({
        Authorization: 'Bearer ${env:FIRECRAWL_API_KEY}',
      });
      expect((written.opencode as any).mcp.firecrawl.headers).toEqual({
        Authorization: 'Bearer {env:FIRECRAWL_API_KEY}',
      });
    });

    it('authenticates Codex through its native bearer token variable', async () => {
      await setupMcpClient('codex', {
        rules: false,
        ctx: { ...ctx, auth: 'env' },
      });

      const config = read(ctx.home, '.codex', 'config.toml');
      expect(config).toContain('bearer_token_env_var = "FIRECRAWL_API_KEY"');
    });

    it('still configures MCP when the rule write fails', async () => {
      // A file where the rules directory needs to be blocks the rule write.
      const rulesPath = path.join(ctx.home, '.cursor', 'rules');
      mkdirSync(path.dirname(rulesPath), { recursive: true });
      writeFileSync(rulesPath, 'not a directory');

      const result = await setupMcpClient('cursor', {
        rules: true,
        ctx,
      });

      expect(result.mcpStatus).toBe('configured');
      expect(result.ruleStatus).toBe('failed');
    });

    it('writes no rule for an agent whose MCP entry failed', async () => {
      const file = path.join(ctx.home, '.cursor', 'mcp.json');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '{ oops');

      const result = await setupMcpClient('cursor', { rules: true, ctx });

      // A rule without a server points the agent at tools it does not have.
      expect(result.mcpStatus).toBe('failed');
      expect(result.ruleStatus).toBe('skipped');
      expect(
        existsSync(path.join(ctx.home, '.cursor', 'rules', 'firecrawl.mdc'))
      ).toBe(false);
    });

    it('reports failure without touching an unparseable config', async () => {
      const file = path.join(ctx.home, '.cursor', 'mcp.json');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '{ oops');

      const result = await setupMcpClient('cursor', {
        rules: false,
        ctx,
      });

      expect(result.mcpStatus).toBe('failed');
      expect(result.mcpDetail).toContain('could not parse');
      expect(read(file)).toBe('{ oops');
    });
  });

  describe('detectMcpClients', () => {
    it('reports only agents present on disk', async () => {
      mkdirSync(path.join(ctx.home, '.cursor'), { recursive: true });
      mkdirSync(path.join(ctx.home, '.codex'), { recursive: true });

      expect(await detectMcpClients(ctx)).toEqual(['cursor', 'codex']);
    });

    it('detects Claude Code from ~/.claude.json without ~/.claude', async () => {
      writeFileSync(path.join(ctx.home, '.claude.json'), '{}');

      expect(await detectMcpClients(ctx)).toEqual(['claude']);
    });

    it('detects VS Code from ~/.vscode without its User directory', async () => {
      mkdirSync(path.join(ctx.home, '.vscode'), { recursive: true });

      expect(await detectMcpClients(ctx)).toEqual(['vscode']);
    });
  });

  describe('resolveMcpClientId', () => {
    it('accepts the aliases used by launch targets', () => {
      expect(resolveMcpClientId('claude-code')).toBe('claude');
      expect(resolveMcpClientId('Codex-App')).toBe('codex');
      expect(resolveMcpClientId('vs-code')).toBe('vscode');
      expect(resolveMcpClientId('nope')).toBeUndefined();
    });

    it('rejects names inherited from the alias table prototype', () => {
      expect(resolveMcpClientId('__proto__')).toBeUndefined();
      expect(resolveMcpClientId('constructor')).toBeUndefined();
    });
  });
});
