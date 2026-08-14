/**
 * Writes the Firecrawl MCP server into an agent's config, and optionally the
 * rule that tells that agent to reach for Firecrawl on web work.
 *
 * Agent configs belong to the user, not to us, so edits are surgical: JSON is
 * patched through a JSONC-aware editor that keeps comments and formatting
 * intact (several agents ship commented settings, which plain `JSON.parse`
 * rejects outright), TOML tables are replaced by AST source range, and shared
 * rule files get a marker-fenced section rather than a rewrite.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser';
import { isMap, isScalar, parseDocument } from 'yaml';
import {
  MCP_CLIENTS,
  MCP_SERVER_NAME,
  RULE_MARKER,
  type McpAuthMode,
  type McpClient,
  type McpClientId,
  type McpContext,
  type McpRuleSpec,
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
  const current = doc.getIn([serversKey], true);
  // A key with nothing under it parses as a null scalar, and setting a path
  // through that refuses to descend. It has to become a collection node:
  // assigning a plain object leaves the same error one level down. An absent
  // key needs none of this, since setIn creates the path itself. A scalar or
  // sequence is already a value; replacing it would drop the user's data, so
  // that fails instead of calling setIn (which throws a yaml-internal error).
  if (isScalar(current) && current.value == null) {
    const empty = current as { comment?: string | null };
    const section = doc.createNode({});
    // That comment belongs to the null value being replaced. A block map has
    // no inline slot on its key, so it moves to the head of the section
    // rather than being dropped with the node it was attached to.
    if (empty?.comment) section.commentBefore = empty.comment;
    doc.setIn([serversKey], section);
  } else if (current != null && !isMap(current)) {
    throw new Error(`Could not update ${serversKey}: expected a mapping.`);
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

function stripBom(content: string): { bom: string; raw: string } {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', raw: content.slice(1) }
    : { bom: '', raw: content };
}

function parseTomlDocument(raw: string): AST.TOMLProgram {
  try {
    return parseTOML(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reason);
  }
}

function isFirecrawlTable(node: AST.TOMLTable, serverName: string): boolean {
  return (
    node.resolvedKey[0] === 'mcp_servers' &&
    String(node.resolvedKey[1]) === serverName
  );
}

function staticHasServer(value: unknown, serverName: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const servers = (value as Record<string, unknown>).mcp_servers;
  return (
    !!servers &&
    typeof servers === 'object' &&
    Object.prototype.hasOwnProperty.call(servers, serverName)
  );
}

/** True when a TOML document already defines `mcp_servers.<name>`. */
export function tomlHasServer(content: string, serverName: string): boolean {
  const { raw } = stripBom(content);
  if (raw.trim() === '') return false;
  try {
    return staticHasServer(getStaticTOMLValue(parseTOML(raw)), serverName);
  } catch {
    return false;
  }
}

/**
 * Insert or replace the `[mcp_servers.<name>]` table. Matching uses the TOML
 * AST `resolvedKey`, so quoted, spaced, and BOM-prefixed headers are the same
 * table. Sub-tables of that server are consumed too, so a leftover
 * `[mcp_servers.firecrawl.env]` from an earlier stdio setup cannot collide
 * with the URL we write.
 *
 * Values are emitted as TOML strings; the entries we build are flat by design.
 */
export function upsertTomlServer(
  content: string,
  serverName: string,
  entry: Record<string, string>
): { content: string; alreadyExists: boolean } {
  const { bom, raw } = stripBom(content);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const block = [
    `[mcp_servers.${serverName}]`,
    ...Object.entries(entry).map(
      ([key, value]) => `${key} = ${JSON.stringify(value)}`
    ),
  ].join(eol);

  const finish = (next: string, alreadyExists: boolean) => {
    parseTomlDocument(next);
    return { content: `${bom}${next}`, alreadyExists };
  };

  if (raw.trim() === '') {
    return finish(`${block}${eol}`, false);
  }

  const ast = parseTomlDocument(raw);
  const tables = ast.body[0].body.filter(
    (node): node is AST.TOMLTable =>
      node.type === 'TOMLTable' && isFirecrawlTable(node, serverName)
  );

  if (tables.length === 0) {
    if (staticHasServer(getStaticTOMLValue(ast), serverName)) {
      throw new Error(
        `Firecrawl is defined inline under mcp_servers; convert it to a [mcp_servers.${serverName}] table first`
      );
    }
    const trimmed = raw.replace(/(?:\r?\n)+$/, '');
    return finish(`${trimmed}${eol}${eol}${block}${eol}`, false);
  }

  const ordered = [...tables].sort(
    (left, right) => left.range[0] - right.range[0]
  );
  const insertAt = ordered[0].range[0];
  let next = raw;
  for (const table of [...ordered].reverse()) {
    // The block goes in without a trailing newline, so whatever follows the
    // first table has to keep supplying one. Taking it here would run the last
    // value straight into the next line: `url = "..."[mcp_servers.other]`.
    const end =
      table === ordered[0]
        ? table.range[1]
        : tableRangeEnd(next, table.range[1]);
    next = `${next.slice(0, table.range[0])}${next.slice(end)}`;
  }
  const replaced = `${next.slice(0, insertAt)}${block}${next.slice(insertAt)}`;
  return finish(replaced.endsWith('\n') ? replaced : `${replaced}${eol}`, true);
}

/** Include the table's terminating newline so a hole is not left behind. */
function tableRangeEnd(raw: string, end: number): number {
  if (raw.startsWith('\r\n', end)) return end + 2;
  if (raw[end] === '\n') return end + 1;
  return end;
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
  const existing = (await readIfExists(filePath)) ?? '';
  // The file belongs to the user, so the section adopts its line endings
  // instead of mixing LF into a CRLF document.
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const section = `${RULE_MARKER}${eol}${content.replace(/\r?\n/g, eol)}${RULE_MARKER}`;
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
    existing.length === 0 ? '' : existing.endsWith('\n') ? eol : `${eol}${eol}`;
  await writeFileEnsuringDir(
    filePath,
    `${existing}${separator}${section}${eol}`
  );
  return 'installed';
}

async function writeMcpEntry(
  client: McpClient,
  ctx: McpContext
): Promise<{ status: 'configured' | 'reconfigured'; configPath: string }> {
  const configPath = client.globalConfigPath(ctx);
  // Some agents will not start the sign-in flow from a URL alone.
  const entry =
    ctx.auth === 'oauth' && client.oauth?.entry
      ? { ...client.buildEntry(ctx), ...client.oauth.entry }
      : client.buildEntry(ctx);

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

export async function writeConfiguredRule(
  rule: McpRuleSpec,
  rulePath: string
): Promise<{ status: 'installed' | 'updated' | 'unsupported'; path: string }> {
  switch (rule.kind) {
    case 'manual':
      return { status: 'unsupported', path: rule.nextStep };
    case 'file':
      return {
        status: await writeRuleFile(rulePath, rule.content),
        path: rulePath,
      };
    case 'append':
      return {
        status: await appendRuleSection(rulePath, rule.content),
        path: rulePath,
      };
    default: {
      const unreachable: never = rule;
      return unreachable;
    }
  }
}

async function writeRule(
  client: McpClient,
  ctx: McpContext
): Promise<{ status: 'installed' | 'updated' | 'unsupported'; path: string }> {
  const rule = client.rule;
  if (!rule) return { status: 'unsupported', path: '' };
  const rulePath = rule.kind === 'manual' ? '' : rule.globalPath(ctx);
  return writeConfiguredRule(rule, rulePath);
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

  // The rule tells an agent to prefer Firecrawl tools. Writing one for an agent
  // whose server entry failed would point it at tools it does not have, so the
  // dependency runs this way only: a failed rule still leaves MCP working.
  if (!options.rules || result.mcpStatus === 'failed') return result;

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
