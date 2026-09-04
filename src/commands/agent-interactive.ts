/**
 * Interactive ACP agent for data gathering.
 *
 * Detects locally-installed ACP-compatible agents (Claude Code, Codex,
 * Gemini CLI, etc.), walks the user through an interactive flow to describe
 * the data they need, then connects to the selected agent via ACP to gather,
 * structure, and deliver datasets as CSV, JSON, or markdown.
 */

import { type ACPAgent, detectAgents } from '../acp/registry';
import { connectToAgent } from '../acp/client';
import { startTUI } from '../acp/tui';
import {
  createSession,
  getSessionDir,
  loadSession,
  updateSession,
  loadPreferences,
  savePreferences,
} from '../utils/acp';
import {
  FIRECRAWL_TOOLS_BLOCK,
  SUBAGENT_INSTRUCTIONS,
} from './experimental/shared';

const bold = (s: string) => (process.stderr.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

// ─── Suggestions ────────────────────────────────────────────────────────────

const SUGGESTIONS = [
  {
    name: 'Top 50 AI startups — name, funding, team size, product URL',
    value:
      'Find the top 50 AI startups with their name, funding amount, team size, and product URL',
  },
  {
    name: 'SaaS pricing pages — company, tiers, price points, features per tier',
    value:
      'Extract pricing data from major SaaS companies including company name, tier names, price points, and features per tier',
  },
  {
    name: 'YC W24 batch — company, founder, one-liner, industry, stage',
    value:
      'Find all Y Combinator W24 batch companies with company name, founder names, one-liner description, industry, and funding stage',
  },
  {
    name: 'GitHub trending repos — repo, stars, language, description, author',
    value:
      'Extract GitHub trending repositories with repo name, star count, primary language, description, and author',
  },
];

// ─── System prompt builder ──────────────────────────────────────────────────

function buildSystemPrompt(opts: {
  format: string;
  sessionDir: string;
}): string {
  const outputInstructions: Record<string, string> = {
    csv: `Write a CSV file to \`${opts.sessionDir}/output.csv\`.
- First row must be column headers.
- Use proper CSV escaping (quote fields containing commas, newlines, or quotes).
- Every row must have the same number of columns.
- Tell the user the file path and record count when done.`,

    json: `Write a JSON file to \`${opts.sessionDir}/output.json\`.
Use this structure:
\`\`\`json
{
  "metadata": {
    "query": "...",
    "sources": ["url1", "url2"],
    "extractedAt": "ISO-8601",
    "totalRecords": N
  },
  "records": [ { ... }, ... ]
}
\`\`\`
Each record object must have identical keys. Tell the user the file path and record count when done.`,

    report: `Write a markdown file to \`${opts.sessionDir}/output.md\`.
- Start with a brief summary (1-2 lines).
- Render all data as a markdown table.
- If too many columns, use multiple tables grouped by category.
- Tell the user the file path and record count when done.`,
  };

  return `You are Firecrawl Agent — a data gathering tool that builds structured datasets from the web.

**MANDATORY: You MUST use the \`firecrawl\` CLI for ALL web access.** Run \`firecrawl search\` to search and \`firecrawl scrape\` to scrape. Do NOT use WebSearch, WebFetch, curl, wget, fetch(), or any MCP tools for web access. Do NOT use firecrawl MCP tools — use the CLI via Bash only. This is non-negotiable.

You are running inside a CLI. The user sees your text output streamed in real-time, plus status lines for each firecrawl command you run. Structure your output for readability in a terminal.

## Session Directory

Your working directory for this session is: \`${opts.sessionDir}\`

Your output file: \`${opts.sessionDir}/output.${opts.format === 'csv' ? 'csv' : opts.format === 'json' ? 'json' : 'md'}\`

**Save all scraped pages** to the session directory using the firecrawl convention:
\`\`\`
${opts.sessionDir}/sites/<hostname>/<path>/index.md
\`\`\`

For example, when scraping \`https://vercel.com/pricing\`:
\`\`\`
firecrawl scrape "https://vercel.com/pricing" -o "${opts.sessionDir}/sites/vercel.com/pricing/index.md"
\`\`\`

This way the user gets both the structured output file AND the raw source pages organized by site. Always use the \`-o\` flag to save scrapes to this structure.

## Tools

The \`firecrawl\` CLI is already installed and authenticated. Use it for ALL web access. Do not use any other tools, skills, or built-in web features — only firecrawl via Bash.

**First step on any task: run \`firecrawl --help\` to see all commands, then \`firecrawl <command> --help\` for the specific command you need.** This ensures you use the right flags.

### Key commands:

**Search the web:**
\`\`\`
firecrawl search "query" --limit 10
\`\`\`

**Scrape a page (returns clean markdown):**
\`\`\`
firecrawl scrape <url>
firecrawl scrape <url> --only-main-content     # strip nav/footer
firecrawl scrape <url> --wait-for 3000          # wait for JS to render
firecrawl scrape <url> --format json            # structured JSON output
firecrawl scrape <url> -o output.md             # save to file
\`\`\`

**Discover URLs on a site:**
\`\`\`
firecrawl map <url> --limit 50
\`\`\`

**Crawl an entire site:**
\`\`\`
firecrawl crawl <url> --limit 20
\`\`\`

### Rules:
- **Do NOT use \`firecrawl browser\` or \`firecrawl interact\`** — stick to search + scrape.
- Always quote URLs in commands.
- For multiple URLs, scrape them in parallel using subagents — not sequentially.
- Save scraped content to temp files when you need to parse it (e.g., \`firecrawl scrape <url> -o /tmp/page.md\`).

## How You Work

**Match your effort to the request:**
- **Simple request** (one site, specific data): Skip the plan. Just scrape it, extract the data, write the output. Done in one turn.
- **Medium request** (a few sources): Propose a quick plan, then execute after confirmation.
- **Large request** (many sources, comprehensive): Full plan with schema confirmation, then multi-source extraction.

For simple requests, do NOT ask "shall I proceed?" — just do it. Only stop for confirmation on medium/large requests where the plan matters.

### Phase 1: Plan
Propose a schema (list fields as bullet points, not a table — tables render poorly in terminals) and a brief plan of what sources you'll check. Then STOP and wait.

Example output:
\`\`\`
Fields: name, funding, team_size, product_url, category, source_url

Plan:
1. Search for "top AI startups" lists
2. Scrape Forbes AI 50, TechCrunch, TopStartups.io
3. Cross-reference and deduplicate
4. Write ${opts.format.toUpperCase()} with ~50 records

Shall I proceed?
\`\`\`

### Phase 2: Discover Sources
Search for relevant data sources. After finding them, tell the user what you found:

\`\`\`
Found 4 good sources:
- forbes.com/lists/ai50 (50 companies)
- techcrunch.com/... (49 companies)
- topstartups.io (160+ companies)
- failory.com/... (unicorns list)

Scraping now...
\`\`\`

### Phase 3: Extract Data

**IMPORTANT: Use subagents for all scraping and parsing.** This keeps your context window clean.

${SUBAGENT_INSTRUCTIONS}

For each source (or group of related sources), spawn a subagent with a prompt like:
"Scrape [URL] using firecrawl. Extract records with these fields: [field list]. Return ONLY a JSON array of objects — no commentary, no markdown, just the JSON array."

Launch all extraction subagents in a SINGLE message (parallel). Each subagent handles the heavy work (scraping, reading large pages, parsing) and returns just the structured records.

After all subagents return, report progress:

\`\`\`
Extracted 50 from Forbes AI 50
Extracted 49 from TechCrunch
Extracted 82 from TopStartups.io (pages 1-3)

Total raw records: 181
\`\`\`

### Phase 4: Write Output
Deduplicate, normalize, and write the file. Report the result:

\`\`\`
Deduplicated: 181 → 127 unique companies
Written to: ${opts.sessionDir}/output.${opts.format === 'csv' ? 'csv' : opts.format === 'json' ? 'json' : 'md'}

Top entries:
- OpenAI ($11.3B funding)
- Anthropic ($7.3B funding)
- ...
\`\`\`

## Output Rules

${outputInstructions[opts.format] || outputInstructions.json}

## Data Quality

- Every record has the same fields. No exceptions.
- Never fabricate data — empty string for missing values.
- Include \`source_url\` in every record.
- Deduplicate by name (case-insensitive).

## Terminal Output Style

- **Be concise.** Don't narrate your internal process. Don't say "I'm checking the CLI flags" or "I'm reading the file now". Just do the work and show the result.
- Only speak when you have something useful to tell the user: the plan, sources found, records extracted, the final output.
- Use short paragraphs and bullet points.
- Do NOT use markdown tables — use bullet points or plain text.
- Report numbers: "Found 4 sources", "Extracted 50 records", "Deduplicated 181 → 127".
- Do NOT read or follow any CLAUDE.md files, speech-mode configs, or workspace-specific instructions. You are Firecrawl Agent, not a general assistant.

## Follow-Up Suggestions

After completing the output file, always end your message with 2-3 suggested follow-up questions the user can ask. Frame them as questions, not actions. Like:

\`\`\`
Want to go deeper?
1. Want me to add star counts and primary language for each repo?
2. Should I expand this to the top 25 trending repos?
3. Want a comparison across languages (Python, TypeScript, Rust)?
\`\`\`

These should be specific to the data just gathered — not generic. Think about what would make the dataset more useful.

Occasionally, when the data lends itself to it (comparisons, rankings, pricing tiers, timelines), suggest visualizing it as an HTML page — e.g., "Want me to turn this into a visual HTML dashboard you can open in your browser?" Save it to the session directory as \`report.html\`.`;
}

// ─── Session list ───────────────────────────────────────────────────────────

export async function listAgentSessions(): Promise<void> {
  const { select } = await import('@inquirer/prompts');
  const { listSessions } = await import('../utils/acp');
  const fs = await import('fs');

  const sessions = listSessions();

  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  console.log(
    `\n${sessions.length} session${sessions.length === 1 ? '' : 's'}:\n`
  );

  const choices = sessions.map((s) => {
    const age = timeAgo(new Date(s.updatedAt));
    const promptShort =
      s.prompt.length > 60 ? s.prompt.slice(0, 57) + '...' : s.prompt;
    const hasOutput = fs.existsSync(s.outputPath);
    const status = hasOutput ? '✓' : '·';
    return {
      name: `${status} ${promptShort}  ${dim(`${s.format.toUpperCase()} · ${s.provider} · ${age}`)}`,
      value: s.id,
    };
  });

  choices.push({ name: dim('Done'), value: '__done__' });

  const chosen = await select({
    message: 'Select a session',
    choices,
  });

  if (chosen === '__done__') return;

  const session = sessions.find((s) => s.id === chosen)!;
  const hasOutput = fs.existsSync(session.outputPath);

  console.log(`\nSession ${session.id}`);
  console.log(`  Prompt:  ${session.prompt}`);
  console.log(`  Agent:   ${session.provider}`);
  console.log(`  Format:  ${session.format.toUpperCase()}`);
  console.log(`  Created: ${new Date(session.createdAt).toLocaleString()}`);
  console.log(
    `  Output:  ${hasOutput ? session.outputPath : '(not yet written)'}`
  );

  const actions = [
    { name: 'Resume this session', value: 'resume' },
    ...(hasOutput
      ? [{ name: `Open ${session.outputPath.split('/').pop()}`, value: 'open' }]
      : []),
    { name: 'Open session folder', value: 'folder' },
    { name: 'Back', value: 'back' },
  ];

  const action = await select({ message: 'Action', choices: actions });

  if (action === 'resume') {
    await runInteractiveAgent({ session: session.id });
  } else if (action === 'open') {
    const { execSync } = await import('child_process');
    try {
      execSync(`open "${session.outputPath}"`);
    } catch {
      console.log(session.outputPath);
    }
  } else if (action === 'folder') {
    const { execSync } = await import('child_process');
    const { getSessionDir } = await import('../utils/acp');
    try {
      execSync(`open "${getSessionDir(session.id)}"`);
    } catch {
      console.log(getSessionDir(session.id));
    }
  }
}

function timeAgo(date: Date): string {
  const secs = Math.round((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ─── Session end ────────────────────────────────────────────────────────────

async function showSessionEnd(
  sessionId: string,
  outputPath: string,
  sessionDir: string
): Promise<void> {
  const { select } = await import('@inquirer/prompts');
  const fs = await import('fs');
  const { execSync } = await import('child_process');

  console.log(`\nSession ${sessionId} saved.`);

  // Build choices — only show output file + session folder, not internals
  const choices: Array<{ name: string; value: string }> = [];

  if (fs.existsSync(outputPath)) {
    const stat = fs.statSync(outputPath);
    const size =
      stat.size > 1024 ? `${Math.round(stat.size / 1024)}KB` : `${stat.size}B`;
    const basename = outputPath.split('/').pop() || 'output';
    choices.push({
      name: `Open ${basename} (${size})`,
      value: `file:${outputPath}`,
    });
  }
  choices.push({ name: 'Open session folder', value: `folder:${sessionDir}` });
  choices.push({ name: 'Done', value: 'done' });

  const action = await select({
    message: 'What next?',
    choices,
  });

  if (action === 'done') return;

  const [type, path] = action.split(':');
  const target = action.slice(type!.length + 1); // handle paths with colons

  try {
    if (process.platform === 'darwin') {
      execSync(`open "${target}"`);
    } else if (process.platform === 'linux') {
      execSync(`xdg-open "${target}"`);
    } else if (process.platform === 'win32') {
      execSync(`start "" "${target}"`);
    }
  } catch {
    console.log(`Path: ${target}`);
  }
}

// ─── Interactive flow ───────────────────────────────────────────────────────

export async function runInteractiveAgent(options: {
  provider?: string;
  session?: string;
  format?: string;
  yes?: boolean;
}): Promise<void> {
  const { input, select } = await import('@inquirer/prompts');

  // ── Resume session ──────────────────────────────────────────────────────
  if (options.session) {
    const session = loadSession(options.session);
    if (!session) {
      console.error(`Session not found: ${options.session}`);
      process.exit(1);
    }

    console.log(`\nResuming session ${session.id}`);
    console.log(`  Provider: ${session.provider}`);
    console.log(`  Prompt: ${session.prompt}`);
    console.log(`  Format: ${session.format}`);
    console.log(`  Iterations: ${session.iterations}\n`);

    const refinement = await input({
      message: 'What would you like to refine or add?',
    });

    updateSession(session.id, {
      iterations: session.iterations + 1,
    });

    const systemPrompt = buildSystemPrompt({
      format: session.format,
      sessionDir: getSessionDir(session.id),
    });

    const userMessage = `Continue from previous session. Original request: "${session.prompt}". Schema fields: ${session.schema.join(', ')}. Output already at: ${session.outputPath}. New instruction: ${refinement}`;

    // Look up the ACP binary for this provider
    const agents = detectAgents();
    const resumeAgent = agents.find(
      (a) => a.name === session.provider && a.available
    );
    if (!resumeAgent) {
      console.error(
        `Agent "${session.provider}" is not available. Install it first.`
      );
      process.exit(1);
    }

    console.log(`\n🔥 ${bold('Firecrawl Agent')} — Resuming session`);
    console.log(dim('   Press Ctrl+C to cancel\n'));

    const resumeTui = startTUI({
      sessionId: session.id,
      agentName: resumeAgent.displayName,
      format: session.format,
      sessionDir: getSessionDir(session.id),
    });

    let agent: Awaited<ReturnType<typeof connectToAgent>> | null = null;

    const handleInterrupt = () => {
      resumeTui.cleanup();
      process.stderr.write('\nInterrupted.\n');
      if (agent) {
        agent.cancel().catch(() => {});
        agent.close();
      }
      process.exit(0);
    };
    process.on('SIGINT', handleInterrupt);

    try {
      agent = await connectToAgent({
        bin: resumeAgent.bin,
        systemPrompt,
        callbacks: {
          onText: (text) => resumeTui.onText(text),
          onToolCall: (call) => resumeTui.onToolCall(call),
          onToolCallUpdate: (call) => resumeTui.onToolCallUpdate(call),
          onUsage: (update) => resumeTui.onUsage(update),
        },
      });

      // Conversation loop (same as main flow)
      let currentMessage = userMessage;
      while (true) {
        const result = await agent.prompt(currentMessage);
        resumeTui.pause();
        process.stdout.write('\n');

        if (result.stopReason !== 'end_turn') {
          resumeTui.printSummary();
          break;
        }

        const followUp = await input({
          message: '→',
          default: '',
        });

        const trimmed = followUp.trim().toLowerCase();
        if (
          !trimmed ||
          trimmed === 'done' ||
          trimmed === 'exit' ||
          trimmed === 'quit'
        ) {
          resumeTui.printSummary();
          await showSessionEnd(
            session.id,
            session.outputPath,
            getSessionDir(session.id)
          );
          break;
        }

        resumeTui.resume();
        resumeTui.startWorking();
        currentMessage = followUp;
      }
    } catch (error) {
      resumeTui.cleanup();
      console.error('\nError:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      process.removeListener('SIGINT', handleInterrupt);
      if (agent) agent.close();
    }
    return;
  }

  // ── Banner ──────────────────────────────────────────────────────────────
  const orange = (s: string) =>
    process.stderr.isTTY ? `\x1b[38;5;208m${s}\x1b[0m` : s;
  console.log(
    orange(`
  ███████╗██╗██████╗ ███████╗ ██████╗██████╗  █████╗ ██╗    ██╗██╗
  ██╔════╝██║██╔══██╗██╔════╝██╔════╝██╔══██╗██╔══██╗██║    ██║██║
  █████╗  ██║██████╔╝█████╗  ██║     ██████╔╝███████║██║ █╗ ██║██║
  ██╔══╝  ██║██╔══██╗██╔══╝  ██║     ██╔══██╗██╔══██║██║███╗██║██║
  ██║     ██║██║  ██║███████╗╚██████╗██║  ██║██║  ██║╚███╔███╔╝███████╗
  ╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝
   █████╗  ██████╗ ███████╗███╗   ██╗████████╗
  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝`)
  );
  console.log('');

  // ── Detect agents ───────────────────────────────────────────────────────
  const agents = detectAgents();
  const available = agents.filter((a) => a.available);

  if (available.length === 0) {
    // Check if raw CLIs are installed (but ACP adapters aren't)
    const { execSync } = await import('child_process');
    const hasClaude = (() => {
      try {
        execSync('which claude', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    })();
    const hasCodex = (() => {
      try {
        execSync('which codex', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    })();

    if (hasClaude || hasCodex) {
      console.error('\nNo ACP adapters found, but you have:');
      if (hasClaude)
        console.error(
          '  ✓ Claude Code (claude) — install adapter: npm install -g @zed-industries/claude-agent-acp'
        );
      if (hasCodex)
        console.error(
          '  ✓ Codex (codex) — install adapter: npm install -g @zed-industries/codex-acp'
        );
      console.error('');
    } else {
      console.error(
        '\nNo ACP-compatible agents found. Install one of:\n' +
          '  npm install -g @zed-industries/claude-agent-acp  (Claude Code)\n' +
          '  npm install -g @zed-industries/codex-acp         (Codex)\n' +
          '  See https://agentclientprotocol.com/get-started/agents\n'
      );
    }
    process.exit(1);
  }

  // ── Select agent ────────────────────────────────────────────────────────
  let selectedAgent: ACPAgent;
  const prefs = loadPreferences();

  if (options.provider) {
    const match = agents.find((a) => a.name === options.provider);
    if (!match || !match.available) {
      console.error(
        `Agent "${options.provider}" is not installed. Available: ${available.map((a) => a.name).join(', ')}`
      );
      process.exit(1);
    }
    selectedAgent = match;
  } else {
    // Always show picker — default to last-used agent
    const defaultAgent = prefs.defaultAgent || available[0].name;
    const installedChoices = available.map((a) => ({
      name: a.displayName,
      value: a.name,
      disabled: false as const,
    }));
    const notInstalled = agents.filter((a) => !a.available);
    const agentChoices = [
      ...installedChoices,
      ...(notInstalled.length > 0
        ? [
            {
              name: '─── Not installed ───',
              value: '_sep',
              disabled: 'separator' as const,
            },
            ...notInstalled.map((a) => ({
              name: a.displayName,
              value: a.name,
              disabled: 'not installed' as const,
            })),
          ]
        : []),
    ];

    const chosen = await select({
      message: 'Harness',
      choices: agentChoices,
      default: defaultAgent,
    });

    selectedAgent = agents.find((a) => a.name === chosen)!;
    savePreferences({ defaultAgent: selectedAgent.name });
  }

  // ── Gather prompt ───────────────────────────────────────────────────────
  let prompt = await input({
    message: 'What data do you want to gather?',
    default: '',
  });

  // If empty, show suggestions to pick from
  if (!prompt.trim()) {
    const picked = await select({
      message: 'Pick an example:',
      choices: SUGGESTIONS.map((s) => ({ name: s.name, value: s.value })),
    });
    prompt = picked;
  }

  // ── Seed URLs ───────────────────────────────────────────────────────────
  const urls = await input({
    message:
      'Any URLs to start from? (comma-separated, leave blank to auto-discover)',
    default: '',
  });

  // ── Output format ───────────────────────────────────────────────────────
  const format =
    options.format ||
    (await select({
      message: 'Output format?',
      choices: [
        { name: 'CSV (spreadsheet-ready)', value: 'csv' },
        { name: 'JSON (structured, API-ready)', value: 'json' },
        { name: 'Markdown table (human-readable)', value: 'report' },
      ],
    }));

  // ── Create session ──────────────────────────────────────────────────────
  const session = createSession({
    provider: selectedAgent.name,
    prompt,
    schema: [],
    format,
  });

  // ── Build message ─────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt({
    format,
    sessionDir: getSessionDir(session.id),
  });

  const parts = [`Gather data: ${prompt}`];
  if (urls.trim()) parts.push(`Start from these URLs: ${urls}`);
  const userMessage = parts.join('. ') + '.';

  console.log(
    `\n  ${selectedAgent.displayName} · ${format.toUpperCase()} · Session ${session.id}`
  );
  console.log(dim(`  Press Ctrl+C to cancel · type "done" to finish\n`));

  // Start TUI
  const sessionDir = getSessionDir(session.id);
  const tui = startTUI({
    sessionId: session.id,
    agentName: selectedAgent.displayName,
    format,
    sessionDir,
  });

  // Handle Ctrl+C gracefully
  let agent: Awaited<ReturnType<typeof connectToAgent>> | null = null;

  const handleInterrupt = () => {
    tui.cleanup();
    process.stderr.write('\nInterrupted.\n');
    if (agent) {
      agent.cancel().catch(() => {});
      agent.close();
    }
    process.exit(0);
  };
  process.on('SIGINT', handleInterrupt);

  try {
    agent = await connectToAgent({
      bin: selectedAgent.bin,
      systemPrompt,
      callbacks: {
        onText: (text) => tui.onText(text),
        onToolCall: (call) => tui.onToolCall(call),
        onToolCallUpdate: (call) => tui.onToolCallUpdate(call),
        onUsage: (update) => tui.onUsage(update),
      },
    });

    // ── Conversation loop ─────────────────────────────────────────────────
    tui.startWorking();
    let currentMessage = userMessage;
    while (true) {
      const result = await agent.prompt(currentMessage);

      // Unmount TUI for user input
      tui.pause();
      process.stdout.write('\n');

      // If the agent stopped for a reason other than end_turn, break
      if (result.stopReason !== 'end_turn') {
        tui.printSummary();
        break;
      }

      // Ask user for follow-up (default action)
      const followUp = await input({
        message: '→',
        default: '',
      });

      const trimmed = followUp.trim().toLowerCase();
      if (
        !trimmed ||
        trimmed === 'done' ||
        trimmed === 'exit' ||
        trimmed === 'quit'
      ) {
        tui.printSummary();
        await showSessionEnd(
          session.id,
          session.outputPath,
          getSessionDir(session.id)
        );
        break;
      }

      // Remount TUI for next turn — show spinner immediately
      tui.resume();
      tui.startWorking();
      currentMessage = followUp;
    }
  } catch (error) {
    tui.cleanup();
    console.error('\nError:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    tui.cleanup();
    process.removeListener('SIGINT', handleInterrupt);
    if (agent) agent.close();
  }
}

// ─── Headless mode ──────────────────────────────────────────────────────────

/**
 * Run an ACP agent headlessly with a prompt. Returns the session path
 * so callers (other agents, scripts) know where to find the output.
 */
export async function runHeadlessAgent(opts: {
  prompt: string;
  format?: string;
  provider?: string;
}): Promise<void> {
  const agents = detectAgents();
  const available = agents.filter((a) => a.available);

  if (available.length === 0) {
    console.error('No ACP agents found.');
    process.exit(1);
  }

  // Pick agent: flag > preference > first available
  const prefs = loadPreferences();
  const agentName = opts.provider || prefs.defaultAgent || available[0].name;
  const selectedAgent =
    available.find((a) => a.name === agentName) || available[0];
  const format = opts.format || 'json';

  const session = createSession({
    provider: selectedAgent.name,
    prompt: opts.prompt,
    schema: [],
    format,
  });

  const sessionDir = getSessionDir(session.id);
  const systemPrompt = buildSystemPrompt({ format, sessionDir });
  const userMessage = `Gather data: ${opts.prompt}.`;

  // Run in background — spawn detached process
  const { spawn } = await import('child_process');

  // Write args to a temp file since system prompts can be huge
  const fs = await import('fs');
  const argsPath = `${sessionDir}/worker-args.json`;
  fs.writeFileSync(
    argsPath,
    JSON.stringify({
      sessionId: session.id,
      agentBin: selectedAgent.bin,
      systemPrompt,
      userMessage,
    })
  );

  // Spawn a detached node process that runs the worker
  const child = spawn(
    process.execPath, // node or tsx
    [
      ...process.execArgv, // preserve tsx loader flags
      __filename,
      '__headless_worker__',
      argsPath,
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    }
  );
  child.unref();

  console.log(
    `Running with ${selectedAgent.displayName} (session ${session.id})`
  );
  console.log(`Output: ${session.outputPath}`);
  console.log(`Log:    ${sessionDir}/agent.log`);
  console.log(`\nTail the log: tail -f ${sessionDir}/agent.log`);
}

// ─── Background worker (called by forked process) ──────────────────────────

async function _runHeadlessWorker(
  sessionId: string,
  agentBin: string,
  systemPrompt: string,
  userMessage: string
): Promise<void> {
  const fs = await import('fs');
  const sessionDir = getSessionDir(sessionId);
  const logPath = `${sessionDir}/agent.log`;

  // Append a line to the agent log
  function log(line: string) {
    fs.appendFileSync(logPath, line + '\n');
  }

  log(`[${new Date().toISOString()}] Session started`);
  log(`[agent] ${agentBin}`);
  log(`[prompt] ${userMessage}`);
  log('');

  try {
    const agent = await connectToAgent({
      bin: agentBin,
      systemPrompt,
      callbacks: {
        onText: (text) => {
          // Write agent text to log (strip trailing whitespace per line)
          fs.appendFileSync(logPath, text);
        },
        onToolCall: (call) => {
          const input = call.rawInput as Record<string, unknown> | undefined;
          const cmd = input?.command as string | undefined;
          if (cmd) {
            log(`\n[tool] ${call.title}: ${cmd.slice(0, 200)}`);
          } else {
            log(`\n[tool] ${call.title}`);
          }
        },
        onToolCallUpdate: (call) => {
          if (call.status === 'completed') {
            log(`[done] ${call.title || call.id}`);
          } else if (call.status === 'errored') {
            log(`[fail] ${call.title || call.id}`);
          }
        },
      },
    });

    await agent.prompt(userMessage);
    agent.close();
    updateSession(sessionId, { iterations: 1 });
    log(`\n[${new Date().toISOString()}] Completed`);
  } catch (error) {
    log(
      `\n[${new Date().toISOString()}] Failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// If this file is run as a background worker
if (process.argv[2] === '__headless_worker__') {
  const argsPath = process.argv[3];
  import('fs').then((fs) => {
    const args = JSON.parse(fs.readFileSync(argsPath, 'utf-8'));
    // Clean up args file
    try {
      fs.unlinkSync(argsPath);
    } catch {}
    _runHeadlessWorker(
      args.sessionId,
      args.agentBin,
      args.systemPrompt,
      args.userMessage
    ).then(
      () => process.exit(0),
      () => process.exit(1)
    );
  });
}
