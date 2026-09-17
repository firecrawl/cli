/** Server-authored guidance. The CLI displays it; it never executes it. */
export interface AgentHintOptions {
  /** Suppress returned guidance locally, including in JSON output. */
  agentHints?: boolean;
}

export interface AgentHintMetadata {
  agent_hints?: string[];
}

/** Only accept the documented response field; never derive hints from content. */
export function agentHintMetadata(
  source: unknown,
  enabled = true
): AgentHintMetadata {
  if (!enabled || !source || typeof source !== 'object') return {};
  const hints = (source as AgentHintMetadata).agent_hints;
  if (!Array.isArray(hints)) return {};
  return {
    agent_hints: hints.filter((hint) => typeof hint === 'string').slice(0, 2),
  };
}

/** SDK convenience methods may place response hints beside document fields. */
export function withoutAgentHints<T>(value: T): T {
  if (!value || typeof value !== 'object' || !('agent_hints' in value)) {
    return value;
  }
  const { agent_hints: _hints, ...rest } = value;
  return rest as T;
}

export function errorAgentHints(error: unknown): AgentHintMetadata {
  const value = error as any;
  return {
    ...agentHintMetadata(value?.details),
    ...agentHintMetadata(value?.response?.data),
    ...agentHintMetadata(error),
  };
}

/** stderr keeps raw page content, pipes, and output files free of guidance. */
export function writeAgentHints(source: unknown, enabled = true): void {
  const hints = agentHintMetadata(source, enabled).agent_hints;
  if (hints?.length) {
    process.stderr.write(
      `Agent hints:\n${hints.map((hint) => `- ${hint}`).join('\n')}\n`
    );
  }
}
