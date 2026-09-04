/**
 * `firecrawl prometheus` — ask a Prometheus instance for verified Firecrawl code
 * (`build`) and manage self-healing data feeds (`feeds`).
 *
 * Thin wrapper over the instance's /api/v1 surface (see utils/prometheus-client).
 * Mirrors the reference CLI in the prometheus repo (cli/bin.mjs): same endpoints,
 * same subcommands, same X-Firecrawl-Key (BYOK) auth. Output is TTY-aware —
 * pretty for humans, raw JSON when piped or with --json.
 */
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

import type {
  BuildResult,
  Feed,
  FeedRun,
  PrometheusBuildOptions,
  PrometheusCommonOptions,
  PrometheusFeedCreateOptions,
} from '../types/prometheus';
import { writeOutput } from '../utils/output';
import { prometheusApi, PrometheusApiError } from '../utils/prometheus-client';

const isTTY = () => process.stdout.isTTY;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/** Run a handler, turning Prometheus errors into a clean stderr message + exit 1. */
async function guard(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof PrometheusApiError) {
      if (process.env.PROMETHEUS_DEBUG) {
        process.stderr.write(`${JSON.stringify(err.payload, null, 2)}\n`);
      }
      fail(err.message);
    }
    fail(err instanceof Error ? err.message : String(err));
  }
}

function printJson(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function truncate(s: unknown, n: number): string {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function healthIcon(h: string): string {
  return (
    (
      { healthy: '●', failing: '✗', healing: '↻', pending: '○' } as Record<
        string,
        string
      >
    )[h] || '·'
  );
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length))
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(headers));
  for (const r of rows) console.log(line(r));
}

function parseModel(s: string): { provider?: string; model: string } {
  const [provider, ...rest] = s.split(':');
  return rest.length ? { provider, model: rest.join(':') } : { model: s };
}

function readSchema(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (err) {
    fail(
      `could not read --schema file: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function common(opts: PrometheusCommonOptions): {
  apiKey?: string;
  prometheusUrl?: string;
} {
  return { apiKey: opts.apiKey, prometheusUrl: opts.prometheusUrl };
}

// ── build ────────────────────────────────────────────────────────────────────

async function handleBuild(
  prompt: string,
  opts: PrometheusBuildOptions
): Promise<void> {
  if (!prompt.trim()) {
    fail(
      'build needs a prompt, e.g. firecrawl prometheus build "top 5 HN stories"'
    );
  }

  const body: Record<string, unknown> = { prompt: prompt.trim() };
  if (opts.schema) body.schema = readSchema(opts.schema);
  if (opts.url && opts.url.length) body.urls = opts.url;
  if (opts.model) body.model = parseModel(opts.model);

  if (isTTY() && !opts.json) {
    process.stderr.write('Building… (this runs the agent; ~30–120s)\n');
  }
  const data = await prometheusApi<BuildResult>(
    'POST',
    '/api/v1/build',
    common(opts),
    body
  );

  // Machine path: raw JSON for piping.
  if (opts.json || !isTTY()) {
    printJson(data);
    return;
  }

  // Human path: write artifacts + print a summary.
  const dir = opts.output ? path.resolve(opts.output) : process.cwd();
  const scriptPath = path.join(dir, 'script.ts');
  const samplePath = path.join(dir, 'sample.json');
  writeOutput(data.script, scriptPath, true);
  writeOutput(JSON.stringify(data.sample, null, 2), samplePath, true);

  console.log('\n✓ Built a verified Firecrawl collector');
  if (data.summary) console.log(`\n  ${data.summary}`);
  if (data.howItWorks) console.log(`\n  How it works: ${data.howItWorks}`);
  console.log(`\n  ${data.rowCount} item(s) in the sample.`);
  console.log('\n  Wrote:');
  console.log(`    ${scriptPath}`);
  console.log(`    ${samplePath}`);
  if (data.integration) {
    console.log(
      `\n  Run it:  npm i ${data.integration.dependencies.join(' ')} tsx && ${data.integration.run}`
    );
    console.log(`  Needs:   ${data.integration.env.join(', ')}`);
  }
  console.log(
    `\n  Schedule it:  firecrawl prometheus feeds create "${truncate(prompt, 40)}" --every 6h --session ${data.sessionId}\n`
  );
}

// ── feeds ──────────────────────────────────────────────────────────────────

async function handleFeedsCreate(
  prompt: string | undefined,
  opts: PrometheusFeedCreateOptions
): Promise<void> {
  const body: Record<string, unknown> = {};
  const p = (prompt ?? '').trim();
  if (opts.session) body.sessionId = opts.session;
  if (p) body.prompt = p;
  if (!body.sessionId && !body.prompt) {
    fail(
      'feeds create needs a prompt or --session, e.g. firecrawl prometheus feeds create "..." --every 6h'
    );
  }
  body.every = opts.every || 'daily';
  if (opts.name) body.name = opts.name;
  if (opts.heal) body.heal = opts.heal;
  if (opts.schema) body.schema = readSchema(opts.schema);

  if (isTTY() && !opts.json && body.prompt && !body.sessionId) {
    process.stderr.write('Building the collector first… (~30–120s)\n');
  }
  const data = await prometheusApi<{ feed: Feed }>(
    'POST',
    '/api/v1/feeds',
    common(opts),
    body
  );
  if (opts.json || !isTTY()) return printJson(data);
  const f = data.feed;
  console.log(`\n✓ Feed created: ${f.name}`);
  console.log(`  id:        ${f.id}`);
  console.log(`  schedule:  ${f.schedule.description}`);
  console.log(`  self-heal: ${f.selfHeal ?? '—'}`);
  console.log(`  next run:  ${f.nextRunAt ?? '—'}\n`);
}

async function handleFeedsList(opts: PrometheusCommonOptions): Promise<void> {
  const data = await prometheusApi<{ feeds: Feed[] }>(
    'GET',
    '/api/v1/feeds',
    common(opts)
  );
  if (opts.json || !isTTY()) return printJson(data);
  const feeds = data.feeds || [];
  if (feeds.length === 0) {
    console.log(
      'No feeds yet. Create one with: firecrawl prometheus feeds create "..." --every 6h'
    );
    return;
  }
  const rows = feeds.map((f) => [
    healthIcon(f.health),
    f.id,
    truncate(f.name, 34),
    f.schedule.description,
    f.enabled ? 'on' : 'paused',
    f.latestRun?.rowCount != null ? `${f.latestRun.rowCount} rows` : '—',
  ]);
  printTable(['', 'ID', 'NAME', 'SCHEDULE', 'STATE', 'LATEST'], rows);
}

async function handleFeedsShow(
  id: string,
  opts: PrometheusCommonOptions
): Promise<void> {
  const data = await prometheusApi<{ feed: Feed; runs: FeedRun[] }>(
    'GET',
    `/api/v1/feeds/${id}`,
    common(opts)
  );
  if (opts.json || !isTTY()) return printJson(data);
  const f = data.feed;
  console.log(`\n${healthIcon(f.health)} ${f.name}  (${f.id})`);
  if (f.summary) console.log(`  ${f.summary}`);
  console.log(
    `  schedule:  ${f.schedule.description}${f.schedule.cron ? ` [${f.schedule.cron}]` : ''}`
  );
  console.log(
    `  state:     ${f.enabled ? 'on' : 'paused'} · self-heal: ${f.selfHeal ?? '—'} · health: ${f.health}`
  );
  console.log(`  next run:  ${f.nextRunAt ?? '—'}`);
  console.log('\n  Recent runs:');
  for (const r of (data.runs || []).slice(0, 8)) {
    const when = r.finishedAt ?? r.startedAt ?? '';
    const detail = r.error
      ? ` — ${truncate(r.error, 50)}`
      : r.rowCount != null
        ? ` — ${r.rowCount} rows`
        : '';
    console.log(
      `    ${r.status.padEnd(8)} ${r.kind.padEnd(8)} ${when}${detail}`
    );
  }
  console.log(`\n  Latest data:  firecrawl prometheus feeds data ${f.id}\n`);
}

async function handleFeedsData(
  id: string,
  opts: PrometheusCommonOptions & { output?: string }
): Promise<void> {
  const data = await prometheusApi<unknown>(
    'GET',
    `/api/v1/feeds/${id}/data`,
    common(opts)
  );
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (opts.output) {
    writeOutput(text, path.resolve(opts.output));
  } else {
    process.stdout.write(`${text}\n`);
  }
}

async function handleFeedsAction(
  action: 'run' | 'heal',
  id: string,
  opts: PrometheusCommonOptions
): Promise<void> {
  if (isTTY() && !opts.json) {
    process.stderr.write(
      `${action === 'heal' ? 'Healing' : 'Running'}… (may take a few minutes)\n`
    );
  }
  const data = await prometheusApi<{
    run?: FeedRun;
    healed?: boolean;
    runs?: unknown[];
  }>('POST', `/api/v1/feeds/${id}/${action}`, common(opts));
  if (opts.json || !isTTY()) return printJson(data);
  if (action === 'run' && data.run) {
    const r = data.run;
    const tail =
      r.rowCount != null
        ? ` — ${r.rowCount} rows`
        : r.error
          ? ` — ${r.error}`
          : '';
    console.log(`${r.status === 'success' ? '✓' : '✗'} run ${r.status}${tail}`);
  } else {
    console.log(
      `${data.healed ? '✓ healed' : '✗ could not heal'} — ${data.runs?.length ?? 0} attempt(s)`
    );
  }
}

async function handleFeedsPatch(
  id: string,
  enabled: boolean,
  opts: PrometheusCommonOptions
): Promise<void> {
  const data = await prometheusApi<{ feed: Feed }>(
    'PATCH',
    `/api/v1/feeds/${id}`,
    common(opts),
    { enabled }
  );
  if (opts.json || !isTTY()) return printJson(data);
  console.log(
    `✓ ${data.feed.name} is now ${data.feed.enabled ? 'on' : 'paused'}`
  );
}

async function handleFeedsDelete(
  id: string,
  opts: PrometheusCommonOptions
): Promise<void> {
  const data = await prometheusApi<unknown>(
    'DELETE',
    `/api/v1/feeds/${id}`,
    common(opts)
  );
  if (opts.json || !isTTY()) return printJson(data);
  console.log(`✓ feed ${id} archived`);
}

// ── command wiring ───────────────────────────────────────────────────────────

/** Attach the credential/instance/json options shared by every subcommand. */
function withCommon(cmd: Command): Command {
  return cmd
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (sent as X-Firecrawl-Key; defaults to your saved key)'
    )
    .option(
      '--prometheus-url <url>',
      'Prometheus instance base URL (or set PROMETHEUS_API_URL)'
    )
    .option('--json', 'Output raw JSON', false);
}

export function createPrometheusCommand(): Command {
  const prometheus = new Command('prometheus')
    .alias('prom')
    .description(
      'Ask Prometheus for verified Firecrawl code and manage self-healing data feeds'
    );

  withCommon(
    prometheus
      .command('build')
      .description(
        'Describe the data you want; get a verified Firecrawl collector + a data sample'
      )
      .argument('<prompt...>', 'What to collect, in plain English')
      .option('--schema <file>', 'JSON schema file to constrain the output')
      .option('--url <url...>', 'Target URL(s) to seed the build')
      .option('--model <provider:id>', 'Model override, e.g. openai:gpt-5.5')
      .option(
        '-o, --output <dir>',
        'Directory for script.ts + sample.json (default: cwd)'
      )
  ).action((promptParts: string[], opts: PrometheusBuildOptions) =>
    guard(() => handleBuild(promptParts.join(' '), opts))
  );

  const feeds = new Command('feeds')
    .alias('feed')
    .description(
      'Create and manage self-healing data feeds (recurring collection)'
    );

  withCommon(
    feeds
      .command('create')
      .description(
        'Create a feed from a prompt (builds first) or an existing build --session'
      )
      .argument('[prompt...]', 'What to collect (omit if using --session)')
      .option(
        '--every <schedule>',
        'hourly · 30m · 6h · daily · daily@14:00 · weekly · monday@09:00 · cron',
        'daily'
      )
      .option('--name <name>', 'Feed name')
      .option(
        '--heal <strategy>',
        'off · repair · rebuild · repair_then_rebuild'
      )
      .option(
        '--session <id>',
        'Reuse a prior `build` session instead of rebuilding'
      )
      .option('--schema <file>', 'JSON schema file to constrain the output')
  ).action((promptParts: string[], opts: PrometheusFeedCreateOptions) =>
    guard(() => handleFeedsCreate(promptParts.join(' '), opts))
  );

  withCommon(
    feeds.command('ls').alias('list').description('List your feeds')
  ).action((opts: PrometheusCommonOptions) =>
    guard(() => handleFeedsList(opts))
  );

  withCommon(
    feeds
      .command('show')
      .alias('get')
      .description('Show a feed and its recent runs')
      .argument('<id>', 'Feed id')
  ).action((id: string, opts: PrometheusCommonOptions) =>
    guard(() => handleFeedsShow(id, opts))
  );

  withCommon(
    feeds
      .command('data')
      .description("Print (or save) a feed's latest collected data")
      .argument('<id>', 'Feed id')
  )
    .option('-o, --output <file>', 'Write the data to a file instead of stdout')
    .action((id: string, opts: PrometheusCommonOptions & { output?: string }) =>
      guard(() => handleFeedsData(id, opts))
    );

  withCommon(
    feeds
      .command('run')
      .description('Run a feed now')
      .argument('<id>', 'Feed id')
  ).action((id: string, opts: PrometheusCommonOptions) =>
    guard(() => handleFeedsAction('run', id, opts))
  );

  withCommon(
    feeds
      .command('heal')
      .alias('fix')
      .description('Force a self-heal of a failing feed')
      .argument('<id>', 'Feed id')
  ).action((id: string, opts: PrometheusCommonOptions) =>
    guard(() => handleFeedsAction('heal', id, opts))
  );

  withCommon(
    feeds
      .command('pause')
      .description('Pause a feed')
      .argument('<id>', 'Feed id')
  ).action((id: string, opts: PrometheusCommonOptions) =>
    guard(() => handleFeedsPatch(id, false, opts))
  );

  withCommon(
    feeds
      .command('resume')
      .description('Resume a paused feed')
      .argument('<id>', 'Feed id')
  ).action((id: string, opts: PrometheusCommonOptions) =>
    guard(() => handleFeedsPatch(id, true, opts))
  );

  withCommon(
    feeds
      .command('rm')
      .alias('delete')
      .description('Archive (delete) a feed')
      .argument('<id>', 'Feed id')
  ).action((id: string, opts: PrometheusCommonOptions) =>
    guard(() => handleFeedsDelete(id, opts))
  );

  prometheus.addCommand(feeds);
  return prometheus;
}
