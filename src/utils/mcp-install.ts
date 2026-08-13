/**
 * Writes the Firecrawl MCP server into an agent's config, and optionally the
 * rule that tells that agent to reach for Firecrawl on web work.
 *
 * Agent configs belong to the user, not to us, so edits are surgical: JSON is
 * patched through a JSONC-aware editor that keeps comments and formatting
 * intact (several agents ship commented settings, which plain `JSON.parse`
 * rejects outright), TOML tables are replaced line by line, and shared rule
 * files get a marker-fenced section rather than a rewrite.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { parseDocument } from 'yaml';
import {
  MCP_CLIENTS,
  MCP_SERVER_NAME,
  RULE_MARKER,
  type McpAuthMode,
  type McpClient,
  type McpClientId,
  type McpContext,
  type McpTargetId,
} from './mcp-clients';

export type McpStatus = 'configured' | 'reconfigured' | 'failed';
export type RuleStatus =
  | 'installed'
  | 'updated'
  | 'skipped'
  | 'unsupported'
  | 'failed';

export interface McpClientResult {
  id: McpTargetId;
  name: string;
  mcpStatus: McpStatus;
  /** Config path on success, error message on failure. */
  mcpDetail: string;
  /** How this agent ended up authenticating, after any keyless fallback. */
  auth: McpAuthMode;
  ruleStatus: RuleStatus;
  /** Rule path when one was written, error message on failure, else empty. */
  ruleDetail: string;
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

async function writeFileEnsuringDir(
  filePath: string,
  content: string,
  /** Applied by the OS only when the file is created, never to an existing one. */
  createMode?: number
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: 'utf8', mode: createMode });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Insert or replace `serversKey.serverName` without disturbing the rest of the
 * file. Throws when the existing file is not parseable, so a malformed config
 * is reported rather than overwritten.
 */
export async function writeJsonServerEntry(
  filePath: string,
  serversKey: string,
  serverName: string,
  entry: Record<string, unknown>
): Promise<{ status: 'configured' | 'reconfigured' }> {
  const stored = await readIfExists(filePath);
  // A byte order mark is reported as a parse error even though the document is
  // valid, and editors on Windows write one routinely. Keep it off the parse
  // and put it back on write.
  const bom = stored?.startsWith('\uFEFF') ? '\uFEFF' : '';
  const raw = bom ? stored!.slice(1) : stored;

  if (raw === undefined || raw.trim() === '') {
    const fresh = { [serversKey]: { [serverName]: entry } };
    await writeFileEnsuringDir(
      filePath,
      `${bom}${JSON.stringify(fresh, null, 2)}\n`
    );
    return { status: 'configured' };
  }

  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (
    errors.length > 0 ||
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(`could not parse existing config at ${filePath}`);
  }

  const section = (parsed as Record<string, unknown>)[serversKey];
  const sectionIsObject =
    typeof section === 'object' && section !== null && !Array.isArray(section);
  const alreadyExists =
    sectionIsObject && serverName in (section as Record<string, unknown>);

  // Patch the leaf when the servers map is usable; otherwise replace the whole
  // key, which also covers it being missing or holding a non-object.
  const edits = sectionIsObject
    ? modify(raw, [serversKey, serverName], entry, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      })
    : modify(
        raw,
        [serversKey],
        { [serverName]: entry },
        { formattingOptions: { insertSpaces: true, tabSize: 2 } }
      );

  await writeFileEnsuringDir(filePath, `${bom}${applyEdits(raw, edits)}`);
  return { status: alreadyExists ? 'reconfigured' : 'configured' };
}

/**
 * Insert or replace `serversKey.serverName` in a YAML config. The document is
 * edited as a tree rather than reserialised from plain objects, so comments,
 * key order, and the user's formatting survive. Throws on a document that does
 * not parse, matching how the JSON path treats a config it cannot read.
 */
export function upsertYamlServer(
  content: string,
  serversKey: string,
  serverName: string,
  entry: Record<string, unknown>
): { content: string; alreadyExists: boolean } {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    throw new Error(doc.errors[0].message);
  }

  const alreadyExists = doc.hasIn([serversKey, serverName]);
  // A key with nothing under it parses as a null scalar, and setting a path
  // through that refuses to descend. It has to become a collection node:
  // assigning a plain object leaves the same error one level down. An absent
  // key needs none of this, since setIn creates the path itself.
  if (doc.getIn([serversKey]) === null) {
    doc.setIn([serversKey], doc.createNode({}));
  }
  doc.setIn([serversKey, serverName], entry);

  // Serialising the tree drops a byte order mark and normalises line endings.
  // Both belong to the user's file, so they are restored on the way out.
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const serialized = doc.toString().replace(/^\uFEFF/, '');
  return {
    content: `${bom}${serialized.replace(/\r?\n/g, eol)}`,
    alreadyExists,
  };
}

/**
 * True when the character at `index` is escaped. Backslashes escape each other,
 * so only an odd run of them before the position leaves it escaped.
 */
function isEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let at = index - 1; at >= 0 && line[at] === '\\'; at -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** Advance past a single-line basic or literal string, escapes included. */
function skipQuoted(line: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < line.length) {
    // Only basic strings honour backslash escapes; literal strings have none.
    if (quote === '"' && line[index] === '\\') {
      index += 2;
      continue;
    }
    if (line[index] === quote) return index + 1;
    index += 1;
  }
  return line.length;
}

/**
 * Mark the lines that begin outside a multi-line string, so a `[table]` written
 * inside one is not mistaken for a real table header. Throws when a multi-line
 * string is still open at the end, which is malformed TOML: editing a file this
 * scan cannot follow would corrupt it while reporting success.
 */
function linesOutsideStrings(lines: string[]): boolean[] {
  const outside: boolean[] = [];
  let fence: '"""' | "'''" | null = null;

  for (const line of lines) {
    outside.push(fence === null);
    let index = 0;
    while (index < line.length) {
      if (fence) {
        let close = line.indexOf(fence, index);
        // A basic string honours escapes, so `\"""` is an escaped quote
        // followed by two literal ones rather than the terminator. Literal
        // strings have no escapes, so their fence always closes.
        while (close !== -1 && fence === '"""' && isEscaped(line, close)) {
          close = line.indexOf(fence, close + 1);
        }
        if (close === -1) break;
        index = close + fence.length;
        fence = null;
        continue;
      }
      if (line[index] === '#') break;
      if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
        fence = line[index] === '"' ? '"""' : "'''";
        index += 3;
        continue;
      }
      if (line[index] === '"' || line[index] === "'") {
        index = skipQuoted(line, index, line[index]);
        continue;
      }
      index += 1;
    }
  }

  if (fence) throw new Error('unterminated multi-line string');
  return outside;
}

/**
 * Insert or replace the `[mcp_servers.<name>]` table. Any sub-tables of that
 * server are consumed too, so a leftover `[mcp_servers.firecrawl.env]` from an
 * earlier stdio setup cannot collide with the URL we write.
 *
 * Values are emitted as TOML strings; the entries we build are flat by design.
 */
export function upsertTomlServer(
  content: string,
  serverName: string,
  entry: Record<string, string>
): { content: string; alreadyExists: boolean } {
  const block = [
    `[mcp_servers.${serverName}]`,
    ...Object.entries(entry).map(
      ([key, value]) => `${key} = ${JSON.stringify(value)}`
    ),
  ];

  // Preserve the file's existing line ending; a CRLF config must not be
  // treated as one unmatchable line per table.
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content === '' ? [] : content.split(/\r?\n/);
  const escaped = escapeRegExp(serverName);
  const ownTable = new RegExp(
    `^[ \\t]*\\[mcp_servers\\.${escaped}(\\.[^\\]]+)?\\][ \\t]*(?:#.*)?$`
  );
  const anyTable = /^[ \t]*\[/;
  const outside = linesOutsideStrings(lines);

  const start = lines.findIndex(
    (line, index) => outside[index] && ownTable.test(line)
  );

  if (start === -1) {
    // Tables must follow root-level keys, so append at the end of the file.
    const trimmed = [...lines];
    while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') {
      trimmed.pop();
    }
    const separator = trimmed.length === 0 ? [] : [''];
    return {
      content: [...trimmed, ...separator, ...block, ''].join(eol),
      alreadyExists: false,
    };
  }

  let end = start + 1;
  while (end < lines.length) {
    if (
      outside[end] &&
      anyTable.test(lines[end]) &&
      !ownTable.test(lines[end])
    ) {
      break;
    }
    end += 1;
  }
  // Comments and blank lines directly above the next table introduce it, so
  // they belong to the user's content rather than to the block being replaced.
  while (end - 1 > start && /^[ \t]*(#.*)?$/.test(lines[end - 1])) {
    end -= 1;
  }

  const rest = lines.slice(end);
  // Keep a blank line between our block and whatever follows it.
  const separator = rest.length > 0 && rest[0].trim() !== '' ? [''] : [];
  const replaced = [
    ...lines.slice(0, start),
    ...block,
    ...separator,
    ...rest,
  ].join(eol);

  // Consuming the old table can swallow the file's final newline; restoring it
  // keeps repeat runs byte-identical.
  return {
    content: replaced.endsWith(eol) ? replaced : `${replaced}${eol}`,
    alreadyExists: true,
  };
}

/** Rewrite a rule file we own outright. */
export async function writeRuleFile(
  filePath: string,
  content: string
): Promise<'installed' | 'updated'> {
  const existed = (await readIfExists(filePath)) !== undefined;
  await writeFileEnsuringDir(filePath, content);
  return existed ? 'updated' : 'installed';
}

/**
 * Add or refresh a marker-fenced section inside a file the user also writes to,
 * such as AGENTS.md. Everything outside the markers is left alone.
 */
export async function appendRuleSection(
  filePath: string,
  content: string
): Promise<'installed' | 'updated'> {
  const section = `${RULE_MARKER}\n${content}${RULE_MARKER}`;
  const existing = (await readIfExists(filePath)) ?? '';
  const marker = escapeRegExp(RULE_MARKER);
  const fenced = new RegExp(`${marker}\\r?\\n[\\s\\S]*?${marker}`);

  if (fenced.test(existing)) {
    // Replace via a function so nothing in the rule body is read as a
    // replacement pattern.
    await writeFileEnsuringDir(
      filePath,
      existing.replace(fenced, () => section)
    );
    return 'updated';
  }

  const separator =
    existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  await writeFileEnsuringDir(filePath, `${existing}${separator}${section}\n`);
  return 'installed';
}

async function writeMcpEntry(
  client: McpClient,
  ctx: McpContext
): Promise<{ status: 'configured' | 'reconfigured'; configPath: string }> {
  const configPath = client.globalConfigPath(ctx);
  const entry = client.buildEntry(ctx);

  if (client.format === 'yaml') {
    const existing = (await readIfExists(configPath)) ?? '';
    let patched: { content: string; alreadyExists: boolean };
    try {
      patched = upsertYamlServer(
        existing,
        client.serversKey,
        MCP_SERVER_NAME,
        entry
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `could not parse existing config at ${configPath}: ${reason}`
      );
    }
    await writeFileEnsuringDir(configPath, patched.content, client.createMode);
    return {
      status: patched.alreadyExists ? 'reconfigured' : 'configured',
      configPath,
    };
  }

  if (client.format === 'toml') {
    const existing = (await readIfExists(configPath)) ?? '';
    const stringEntry: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === 'string') stringEntry[key] = value;
    }
    let patched: { content: string; alreadyExists: boolean };
    try {
      patched = upsertTomlServer(existing, MCP_SERVER_NAME, stringEntry);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `could not parse existing config at ${configPath}: ${reason}`
      );
    }
    const { content, alreadyExists } = patched;
    await writeFileEnsuringDir(configPath, content);
    return {
      status: alreadyExists ? 'reconfigured' : 'configured',
      configPath,
    };
  }

  const { status } = await writeJsonServerEntry(
    configPath,
    client.serversKey,
    MCP_SERVER_NAME,
    entry
  );
  return { status, configPath };
}

async function writeRule(
  client: McpClient,
  ctx: McpContext
): Promise<{ status: 'installed' | 'updated' | 'unsupported'; path: string }> {
  const rule = client.rule;
  if (!rule) return { status: 'unsupported', path: '' };

  const rulePath = rule.globalPath(ctx);
  const status =
    rule.kind === 'file'
      ? await writeRuleFile(rulePath, rule.content)
      : await appendRuleSection(rulePath, rule.content);
  return { status, path: rulePath };
}

/**
 * Configure one agent. The MCP entry and the rule are written independently so
 * a rule failure never costs the user a working MCP server.
 */
export async function setupMcpClient(
  id: McpClientId,
  options: { rules: boolean; ctx: McpContext }
): Promise<McpClientResult> {
  const client = MCP_CLIENTS[id];
  const ctx = options.ctx;

  const result: McpClientResult = {
    id,
    name: client.name,
    mcpStatus: 'failed',
    mcpDetail: '',
    auth: ctx.auth,
    ruleStatus: 'skipped',
    ruleDetail: '',
  };

  try {
    const { status, configPath } = await writeMcpEntry(client, ctx);
    result.mcpStatus = status;
    result.mcpDetail = configPath;
  } catch (error) {
    result.mcpDetail = error instanceof Error ? error.message : String(error);
  }

  if (!options.rules) return result;

  try {
    const { status, path: rulePath } = await writeRule(client, ctx);
    result.ruleStatus = status;
    result.ruleDetail = rulePath;
  } catch (error) {
    result.ruleStatus = 'failed';
    result.ruleDetail = error instanceof Error ? error.message : String(error);
  }

  return result;
}
