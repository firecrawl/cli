import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
import {
  appendRuleSection,
  setupMcpClient,
  upsertTomlServer,
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

  describe('setupMcpClient', () => {
    it('writes the keyless URL with no credentials', async () => {
      const result = await setupMcpClient('cursor', {
        scope: 'global',
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
        scope: 'global',
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

    it('uses the environment-reference syntax each agent expands', async () => {
      const written: Record<string, unknown> = {};
      for (const id of ['cursor', 'vscode', 'opencode'] as const) {
        const result = await setupMcpClient(id, {
          scope: 'global',
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
        scope: 'global',
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
        scope: 'global',
        rules: true,
        ctx,
      });

      expect(result.mcpStatus).toBe('configured');
      expect(result.ruleStatus).toBe('failed');
    });

    it('reports failure without touching an unparseable config', async () => {
      const file = path.join(ctx.home, '.cursor', 'mcp.json');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '{ oops');

      const result = await setupMcpClient('cursor', {
        scope: 'global',
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
  });

  describe('resolveMcpClientId', () => {
    it('accepts the aliases used by launch targets', () => {
      expect(resolveMcpClientId('claude-code')).toBe('claude');
      expect(resolveMcpClientId('Codex-App')).toBe('codex');
      expect(resolveMcpClientId('vs-code')).toBe('vscode');
      expect(resolveMcpClientId('nope')).toBeUndefined();
    });
  });
});
