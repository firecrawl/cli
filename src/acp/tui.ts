/**
 * Firecrawl Agent TUI — phase-aware inline terminal display.
 *
 * Renders clear section breaks, tool completions, and a persistent
 * status line showing tokens/cost/time. No ANSI cursor tricks —
 * everything scrolls naturally. Works in pipes and as an agent harness.
 */

import type { ToolCallInfo } from './client';

// ─── Styles (TTY-aware) ─────────────────────────────────────────────────────

const tty = process.stderr.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const cyan = (s: string) => (tty ? `\x1b[36m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const BAR = '━';

// ─── Tool call categorization ───────────────────────────────────────────────

type Phase = 'planning' | 'discovering' | 'extracting' | 'output';

function extractUrl(cmd: string, prefix: string): string | null {
  const quoted = cmd.match(
    new RegExp(`${prefix}\\s+["'](https?://[^"']+)["']`)
  );
  if (quoted) return quoted[1];
  const parts = cmd.replace(new RegExp(`^${prefix}\\s*`), '').split(/\s+/);
  for (const part of parts) {
    const clean = part.replace(/^["']|["']$/g, '');
    if (clean.startsWith('http')) return clean;
  }
  return null;
}

interface CallInfo {
  label: string;
  phase: Phase;
  dedupeKey: string;
}

function categorize(call: ToolCallInfo, sessionDir: string): CallInfo | null {
  const input = call.rawInput as Record<string, unknown> | undefined;
  const title = (call.title || '').toLowerCase();

  // ── Match by Bash command (Terminal tool calls) ─────────────────────
  if (input?.command && typeof input.command === 'string') {
    const cmd = input.command.trim();

    if (cmd.startsWith('firecrawl search')) {
      const m = cmd.match(/firecrawl search\s+["']([^"']+)["']/);
      const q = m ? m[1] : 'web';
      return {
        label: `Searching "${q}"`,
        phase: 'discovering',
        dedupeKey: `search:${q}`,
      };
    }
    if (cmd.startsWith('firecrawl scrape')) {
      const url = extractUrl(cmd, 'firecrawl scrape');
      if (!url) return null;
      return {
        label: `Scraping ${url}`,
        phase: 'extracting',
        dedupeKey: `scrape:${url}`,
      };
    }
    if (cmd.startsWith('firecrawl map')) {
      const url = extractUrl(cmd, 'firecrawl map');
      if (!url) return null;
      return {
        label: `Mapping ${url}`,
        phase: 'extracting',
        dedupeKey: `map:${url}`,
      };
    }
    if (cmd.startsWith('firecrawl crawl')) {
      const url = extractUrl(cmd, 'firecrawl crawl');
      if (!url) return null;
      return {
        label: `Crawling ${url}`,
        phase: 'extracting',
        dedupeKey: `crawl:${url}`,
      };
    }
    if (cmd.startsWith('firecrawl agent')) {
      return {
        label: 'Running extraction agent',
        phase: 'extracting',
        dedupeKey: 'extract-agent',
      };
    }
    if (cmd.includes(sessionDir)) {
      return {
        label: 'Writing output',
        phase: 'output',
        dedupeKey: 'write-session',
      };
    }
    return null;
  }

  // ── Match by title (MCP tools, built-in tools, etc.) ───────────────
  // MCP tools have titles like "firecrawl_scrape", "firecrawl_search"
  // or the tool name itself contains "firecrawl"
  if (
    title.includes('firecrawl_scrape') ||
    title.includes('firecrawl__firecrawl_scrape')
  ) {
    const url = (input?.url as string) || '';
    return {
      label: `Scraping ${url || 'page'}`,
      phase: 'extracting',
      dedupeKey: `scrape:${url}`,
    };
  }
  if (
    title.includes('firecrawl_search') ||
    title.includes('firecrawl__firecrawl_search')
  ) {
    const query = (input?.query as string) || '';
    return {
      label: `Searching "${query || 'web'}"`,
      phase: 'discovering',
      dedupeKey: `search:${query}`,
    };
  }
  if (
    title.includes('firecrawl_map') ||
    title.includes('firecrawl__firecrawl_map')
  ) {
    const url = (input?.url as string) || '';
    return {
      label: `Mapping ${url || 'site'}`,
      phase: 'extracting',
      dedupeKey: `map:${url}`,
    };
  }
  if (
    title.includes('firecrawl_crawl') ||
    title.includes('firecrawl__firecrawl_crawl')
  ) {
    const url = (input?.url as string) || '';
    return {
      label: `Crawling ${url || 'site'}`,
      phase: 'extracting',
      dedupeKey: `crawl:${url}`,
    };
  }
  if (
    title.includes('firecrawl_extract') ||
    title.includes('firecrawl__firecrawl_extract')
  ) {
    return {
      label: 'Extracting data',
      phase: 'extracting',
      dedupeKey: 'extract',
    };
  }

  // WebSearch / WebFetch — built-in tools the agent might use despite instructions
  if (title === 'websearch' || title === 'web_search') {
    const query = (input?.query as string) || '';
    return {
      label: `Searching "${query || 'web'}"`,
      phase: 'discovering',
      dedupeKey: `websearch:${query}`,
    };
  }
  if (title === 'webfetch' || title === 'web_fetch') {
    const url = (input?.url as string) || '';
    return {
      label: `Fetching ${url || 'page'}`,
      phase: 'extracting',
      dedupeKey: `fetch:${url}`,
    };
  }

  // ── File writes to session dir ─────────────────────────────────────
  if (input?.path && typeof input.path === 'string') {
    if (input.path.startsWith(sessionDir) && title.includes('write')) {
      const basename = input.path.split('/').pop() || input.path;
      return {
        label: `Writing ${basename}`,
        phase: 'output',
        dedupeKey: `write:${basename}`,
      };
    }
    return null;
  }

  return null;
}

// ─── Section header ─────────────────────────────────────────────────────────

const SECTION_WIDTH = 54;

function sectionHeader(name: string): string {
  const pad = SECTION_WIDTH - name.length - 5; // "━━━ Name " + bars
  return dim(`${BAR.repeat(3)} ${name} ${BAR.repeat(Math.max(pad, 3))}`);
}

function sectionFooter(): string {
  return dim(BAR.repeat(SECTION_WIDTH));
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface TUIHandle {
  onText: (text: string) => void;
  onToolCall: (call: ToolCallInfo) => void;
  onToolCallUpdate: (call: ToolCallInfo) => void;
  onUsage: (update: {
    size: number;
    used: number;
    cost?: { amount: number; currency: string } | null;
  }) => void;
  addCredits: (n: number) => void;

  /** Show working spinner immediately (call when starting a new turn) */
  startWorking: () => void;
  section: (name: string) => void;
  printStatus: () => void;
  printSummary: () => void;
  pause: () => void;
  resume: () => void;
  cleanup: () => void;
}

export function startTUI(opts: {
  sessionId: string;
  agentName: string;
  format: string;
  sessionDir: string;
}): TUIHandle {
  const calls = new Map<string, CallInfo>();
  const completed = new Set<string>();
  let currentPhase: Phase | null = null;

  // Metrics
  let tokensUsed = 0;
  let tokensTotal = 0;
  let firecrawlCredits = 0;
  const startedAt = Date.now();

  function elapsed(): string {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function statusLine(): string {
    const parts: string[] = [];
    if (tokensUsed > 0) {
      const k = Math.round(tokensUsed / 1000);
      parts.push(`${k}k tokens`);
    }
    if (firecrawlCredits > 0) {
      parts.push(`${firecrawlCredits} credits`);
    }
    parts.push(elapsed());
    return dim(parts.join(' · '));
  }

  function ensurePhase(phase: Phase) {
    if (phase === currentPhase) return;
    const names: Record<Phase, string> = {
      planning: 'Planning',
      discovering: 'Discovering',
      extracting: 'Gathering Data',
      output: 'Output',
    };
    currentPhase = phase;
    process.stderr.write(`\n${sectionHeader(names[phase])}\n\n`);
  }

  // Track cursor state
  let workingShown = false;
  let workingInterval: ReturnType<typeof setInterval> | null = null;
  let spinFrame = 0;
  let lastCharWasNewline = true;
  const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  function ensureNewline() {
    if (!lastCharWasNewline) {
      process.stdout.write('\n');
      lastCharWasNewline = true;
    }
  }

  const WORKING_MESSAGES = [
    'Gathering data',
    'Analyzing sources',
    'Processing results',
    'Crunching numbers',
    'Sifting through pages',
    'Connecting the dots',
    'Piecing it together',
  ];
  let workingMsgIndex = Math.floor(Math.random() * WORKING_MESSAGES.length);
  let workingMsgTicks = 0;

  function showWorking() {
    if (workingShown || !tty) return;
    ensureNewline();
    workingShown = true;
    workingMsgTicks = 0;
    workingInterval = setInterval(() => {
      spinFrame = (spinFrame + 1) % SPIN.length;
      workingMsgTicks++;
      // Rotate message every ~4 seconds
      if (workingMsgTicks % 50 === 0) {
        workingMsgIndex = (workingMsgIndex + 1) % WORKING_MESSAGES.length;
      }
      const msg = WORKING_MESSAGES[workingMsgIndex];
      process.stderr.write(
        `\r  ${dim(`${SPIN[spinFrame]} ${msg}...`)}${''.padEnd(20)}`
      );
    }, 80);
  }

  function clearWorking() {
    if (!workingShown) return;
    workingShown = false;
    if (workingInterval) {
      clearInterval(workingInterval);
      workingInterval = null;
    }
    process.stderr.write(`\r\x1b[2K`);
  }

  return {
    onText(text: string) {
      clearWorking();
      process.stdout.write(text);
      if (text.length > 0) {
        lastCharWasNewline = text[text.length - 1] === '\n';
      }
    },

    onToolCall(call: ToolCallInfo) {
      const info = categorize(call, opts.sessionDir);
      if (!info) {
        showWorking();
        return;
      }
      calls.set(call.id, info);
      showWorking(); // spinner while it runs
    },

    onToolCallUpdate(call: ToolCallInfo) {
      const info = calls.get(call.id);
      if (!info) {
        // Background work completed — keep working indicator if others pending
        return;
      }

      if (call.status === 'completed' || call.status === 'errored') {
        calls.delete(call.id);
        if (completed.has(info.dedupeKey)) return;
        completed.add(info.dedupeKey);

        clearWorking();
        ensureNewline();
        ensurePhase(info.phase);
        const icon = call.status === 'completed' ? green('✓') : red('✗');
        process.stderr.write(`  ${icon} ${info.label}\n`);
      }
    },

    onUsage(update) {
      tokensUsed = update.used;
      tokensTotal = update.size;
    },

    addCredits(n: number) {
      firecrawlCredits += n;
    },

    startWorking() {
      showWorking();
    },

    section(name: string) {
      ensureNewline();
      currentPhase = null;
      process.stderr.write(`\n${sectionHeader(name)}\n\n`);
    },

    printStatus() {
      ensureNewline();
      process.stderr.write(`${statusLine()}\n`);
    },

    printSummary() {
      ensureNewline();
      process.stderr.write(`\n${sectionFooter()}\n`);
      process.stderr.write(`${statusLine()}\n`);
    },

    pause() {
      clearWorking();
      ensureNewline();
      process.stderr.write('\n');
    },

    resume() {
      clearWorking();
      completed.clear();
      currentPhase = null;
    },

    cleanup() {
      clearWorking();
    },
  };
}
