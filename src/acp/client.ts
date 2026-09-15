/**
 * Firecrawl ACP Client — connects to any ACP-compatible agent
 * (Claude Code, Codex, Gemini CLI, etc.) via the Agent Client Protocol.
 *
 * Spawns the agent as a subprocess and communicates via JSON-RPC over stdio.
 * Uses the official @agentclientprotocol/sdk.
 */

import { spawn, type ChildProcess } from 'child_process';
import { Writable, Readable } from 'stream';
import * as acp from '@agentclientprotocol/sdk';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolCallInfo {
  id: string;
  title: string;
  status: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface ACPClientCallbacks {
  onText?: (text: string) => void;
  onToolCall?: (call: ToolCallInfo) => void;
  onToolCallUpdate?: (call: ToolCallInfo) => void;
  onPlan?: (entries: Array<{ content: string; status: string }>) => void;
  onUsage?: (update: {
    size: number;
    used: number;
    cost?: { amount: number; currency: string } | null;
  }) => void;
  onPermissionRequest?: (
    title: string,
    options: Array<{ name: string; optionId: string }>
  ) => Promise<string>; // returns optionId
}

// ─── Client implementation ──────────────────────────────────────────────────

class FirecrawlClient implements acp.Client {
  private callbacks: ACPClientCallbacks;

  constructor(callbacks: ACPClientCallbacks) {
    this.callbacks = callbacks;
  }

  async requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    // Auto-approve by selecting the first "allow" option
    const allowOption = params.options.find(
      (o) => o.kind === 'allow_once' || o.kind === 'allow_always'
    );
    if (allowOption) {
      return {
        outcome: { outcome: 'selected', optionId: allowOption.optionId },
      };
    }

    // If custom handler provided, let them choose
    if (this.callbacks.onPermissionRequest) {
      const optionId = await this.callbacks.onPermissionRequest(
        params.toolCall.title ?? 'Unknown tool',
        params.options.map((o) => ({ name: o.name, optionId: o.optionId }))
      );
      return { outcome: { outcome: 'selected', optionId } };
    }

    // Fallback: select first option
    return {
      outcome: { outcome: 'selected', optionId: params.options[0].optionId },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (
          'content' in update &&
          update.content.type === 'text' &&
          this.callbacks.onText
        ) {
          this.callbacks.onText(update.content.text);
        }
        break;

      case 'tool_call':
        if (this.callbacks.onToolCall) {
          this.callbacks.onToolCall({
            id: update.toolCallId,
            title: update.title ?? 'tool',
            status: update.status ?? 'pending',
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
          });
        }
        break;

      case 'tool_call_update':
        if (this.callbacks.onToolCallUpdate) {
          this.callbacks.onToolCallUpdate({
            id: update.toolCallId,
            title: update.title ?? '',
            status: update.status ?? 'unknown',
            rawInput: update.rawInput,
            rawOutput: update.rawOutput,
          });
        }
        break;

      case 'plan':
        if (this.callbacks.onPlan) {
          this.callbacks.onPlan(
            update.entries.map((e: { content: string; status: string }) => ({
              content: e.content,
              status: e.status,
            }))
          );
        }
        break;

      case 'usage_update':
        if (this.callbacks.onUsage) {
          this.callbacks.onUsage({
            size: update.size,
            used: update.used,
            cost: update.cost ?? undefined,
          });
        }
        break;

      default:
        break;
    }
  }

  async writeTextFile(
    params: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.dirname(params.path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(params.path, params.content, 'utf-8');
    return {};
  }

  async readTextFile(
    params: acp.ReadTextFileRequest
  ): Promise<acp.ReadTextFileResponse> {
    const fs = await import('fs');
    const content = fs.readFileSync(params.path, 'utf-8');
    return { content };
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function connectToAgent(opts: {
  bin: string;
  args?: string[];
  cwd?: string;
  systemPrompt?: string;
  callbacks: ACPClientCallbacks;
}): Promise<{
  connection: acp.ClientSideConnection;
  sessionId: string;
  process: ChildProcess;
  prompt: (text: string) => Promise<acp.PromptResponse>;
  cancel: () => Promise<void>;
  close: () => void;
}> {
  // Spawn agent subprocess — pipe stderr to suppress agent noise
  const agentProcess = spawn(opts.bin, opts.args ?? [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.cwd ?? process.cwd(),
  });

  // Silently discard agent's stderr (hook warnings, debug output, etc.)
  agentProcess.stderr?.resume();

  // Handle spawn errors
  const spawnError = new Promise<never>((_, reject) => {
    agentProcess.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Agent "${opts.bin}" not found. Is it installed?`));
      } else {
        reject(err);
      }
    });
  });

  // Create ACP stream from stdio
  const input = Writable.toWeb(
    agentProcess.stdin!
  ) as WritableStream<Uint8Array>;
  const output = Readable.toWeb(
    agentProcess.stdout!
  ) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  // Create client and connection
  const client = new FirecrawlClient(opts.callbacks);
  const connection = new acp.ClientSideConnection((_agent) => client, stream);

  // Initialize (race with spawn error)
  await Promise.race([
    connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        terminal: true,
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    }),
    spawnError,
  ]);

  // Create session
  const sessionResult = await connection.newSession({
    cwd: opts.cwd ?? process.cwd(),
    mcpServers: [],
  });

  const sessionId = sessionResult.sessionId;

  // Store system prompt to prepend to first message
  const systemContext = opts.systemPrompt;

  return {
    connection,
    sessionId,
    process: agentProcess,

    async prompt(text: string) {
      // Prepend system prompt as context in the first message
      const fullText = systemContext
        ? `<system-context>\n${systemContext}\n</system-context>\n\n${text}`
        : text;
      return connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text: fullText }],
      });
    },

    async cancel() {
      await connection.cancel({ sessionId });
    },

    close() {
      agentProcess.kill();
    },
  };
}
