/**
 * `firecrawl monitor` — manage Firecrawl monitors.
 *
 * Monitors run recurring scrapes/crawls and diff each result against the last
 * retained snapshot. See features/monitoring in the docs.
 *
 * firecrawl@4.22.2 exposes monitor methods (createMonitor,
 * listMonitors, getMonitor, updateMonitor, deleteMonitor, runMonitor,
 * listMonitorChecks, getMonitorCheck), but its HttpClient injects a top-level
 * `origin: js-sdk@<version>` field into every POST/PATCH body and the
 * /v2/monitor endpoint rejects that with "Unrecognized key in body". Until the
 * SDK strips `origin` for monitor requests (or the API accepts it), we hit
 * /v2/monitor directly via fetch — same pattern parse.ts uses.
 *
 * Subcommands:
 *   create | list | get | update | delete | run | checks | check
 */

import * as fs from 'fs';
import { Command } from 'commander';
import { getConfig, validateConfig } from '../utils/config';
import { writeOutput } from '../utils/output';

const DEFAULT_API_URL = 'https://api.firecrawl.dev';

interface CommonOptions {
  apiKey?: string;
  apiUrl?: string;
  output?: string;
  pretty?: boolean;
}

interface MonitorRequestInit {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

async function monitorRequest(
  path: string,
  options: CommonOptions,
  init: MonitorRequestInit = {}
): Promise<unknown> {
  const config = getConfig();
  const apiKey = options.apiKey || config.apiKey;
  validateConfig(apiKey);

  const baseUrl = (options.apiUrl || config.apiUrl || DEFAULT_API_URL).replace(
    /\/$/,
    ''
  );

  let url = `${baseUrl}/v2${path}`;
  if (init.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'X-Origin': 'cli',
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const payload = (await response.json().catch(() => ({}))) as any;

  if (!response.ok || payload?.success === false) {
    const message =
      payload?.error ||
      `HTTP ${response.status}: ${response.statusText || 'Request failed'}`;
    throw new Error(message);
  }

  return payload;
}

function emit(
  payload: unknown,
  options: CommonOptions & { json?: boolean }
): void {
  const text = JSON.stringify(payload, null, options.pretty ? 2 : 0);
  writeOutput(text, options.output, !!options.output);
}

/**
 * Read a JSON payload from a positional arg or piped stdin.
 *
 * - `file` is a path to a .json file, or `-` to read stdin explicitly.
 * - If `file` is omitted and stdin is a pipe, stdin is used.
 * - Returns `undefined` when no source is provided — caller falls back to flags.
 */
async function readJsonPayload(file?: string): Promise<unknown | undefined> {
  if (file === '-' || (!file && !process.stdin.isTTY)) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) return undefined;
    return JSON.parse(raw);
  }
  if (file) {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw);
  }
  return undefined;
}

function parseCommaList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function fail(error: unknown): never {
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
}

/**
 * Build the request body for `monitor create` from CLI flags.
 *
 * For full control, callers can pass a JSON file path positionally or pipe
 * JSON on stdin instead. The flags cover the common scrape-target shape.
 */
export function buildCreateBody(opts: {
  name?: string;
  goal?: string;
  cron?: string;
  scheduleText?: string;
  timezone?: string;
  page?: string;
  urls?: string[];
  crawlUrl?: string;
  webhookUrl?: string;
  webhookEvents?: string[];
  emailRecipients?: string[];
  retentionDays?: number;
}): unknown {
  if (!opts.name) {
    throw new Error('--name is required (or pass a JSON file / stdin payload)');
  }
  if (!opts.cron && !opts.scheduleText) {
    throw new Error('--cron or --schedule is required');
  }
  const urls =
    opts.urls && opts.urls.length > 0
      ? opts.urls
      : opts.page
        ? [opts.page]
        : undefined;
  const hasScrape = urls && urls.length > 0;
  const hasCrawl = !!opts.crawlUrl;
  if (!hasScrape && !hasCrawl) {
    throw new Error('Provide --scrape-urls or --crawl-url');
  }

  const schedule: Record<string, unknown> = {};
  if (opts.cron) schedule.cron = opts.cron;
  if (opts.scheduleText) schedule.text = opts.scheduleText;
  if (opts.timezone) schedule.timezone = opts.timezone;

  const targets: unknown[] = [];
  if (hasScrape) targets.push({ type: 'scrape', urls });
  if (hasCrawl) targets.push({ type: 'crawl', url: opts.crawlUrl });

  const body: Record<string, unknown> = {
    name: opts.name,
    schedule,
    targets,
  };

  if (opts.webhookUrl) {
    body.webhook = {
      url: opts.webhookUrl,
      ...(opts.webhookEvents && opts.webhookEvents.length > 0
        ? { events: opts.webhookEvents }
        : {}),
    };
  }

  if (opts.emailRecipients && opts.emailRecipients.length > 0) {
    body.notification = {
      email: {
        enabled: true,
        recipients: opts.emailRecipients,
      },
    };
  }

  if (opts.retentionDays !== undefined) body.retentionDays = opts.retentionDays;
  if (opts.goal !== undefined) body.goal = opts.goal;

  return body;
}

function commonOptions(cmd: Command): Command {
  return cmd
    .option(
      '-k, --api-key <key>',
      'Firecrawl API key (overrides global --api-key)'
    )
    .option('--api-url <url>', 'API URL (overrides global --api-url)')
    .option('-o, --output <path>', 'Output file path (default: stdout)')
    .option('--pretty', 'Pretty print JSON output', false);
}

/**
 * Build the `firecrawl monitor` command tree.
 */
export function createMonitorCommand(): Command {
  const monitor = new Command('monitor').description(
    'Schedule recurring scrapes/crawls and track content changes'
  );

  // create
  commonOptions(
    monitor
      .command('create')
      .description('Create a monitor (flags, or JSON from file/stdin)')
      .argument(
        '[file]',
        'Path to JSON payload (use "-" or pipe stdin to read from stdin)'
      )
      .option('--name <name>', 'Monitor name')
      .option('--cron <expression>', 'Cron schedule (e.g. "*/30 * * * *")')
      .option(
        '--schedule <text>',
        'Natural-language schedule (e.g. "every 30 minutes")'
      )
      .option('--timezone <tz>', 'Schedule timezone', 'UTC')
      .option('--page <url>', 'Single page URL to scrape on each check')
      .option(
        '--scrape-urls <list>',
        'Comma-separated page URLs to scrape on each check',
        parseCommaList
      )
      .option('--crawl-url <url>', 'Root URL for a crawl target')
      .option('--webhook-url <url>', 'Webhook destination')
      .option(
        '--webhook-events <list>',
        'Comma-separated events (monitor.page, monitor.check.completed)',
        parseCommaList
      )
      .option(
        '--email <list>',
        'Comma-separated email recipients for change notifications',
        parseCommaList
      )
      .option('--retention-days <n>', 'Snapshot retention window', parseInt)
      .option(
        '--goal <text>',
        'Plain-language goal for the AI change judge (auto-enables the judge)'
      )
  ).action(async (file: string | undefined, options) => {
    try {
      const fromJson = await readJsonPayload(file);
      const body =
        fromJson ??
        buildCreateBody({
          name: options.name,
          goal: options.goal,
          cron: options.cron,
          scheduleText: options.schedule,
          timezone: options.timezone,
          page: options.page,
          urls: options.scrapeUrls,
          crawlUrl: options.crawlUrl,
          webhookUrl: options.webhookUrl,
          webhookEvents: options.webhookEvents,
          emailRecipients: options.email,
          retentionDays: options.retentionDays,
        });
      const payload = await monitorRequest('/monitor', options, {
        method: 'POST',
        body,
      });
      emit(payload, options);
    } catch (err) {
      fail(err);
    }
  });

  // list
  commonOptions(
    monitor
      .command('list')
      .description('List monitors')
      .option('--limit <n>', 'Maximum results', parseInt)
      .option('--offset <n>', 'Result offset', parseInt)
  ).action(async (options) => {
    try {
      const payload = await monitorRequest('/monitor', options, {
        query: { limit: options.limit, offset: options.offset },
      });
      emit(payload, options);
    } catch (err) {
      fail(err);
    }
  });

  // get
  commonOptions(
    monitor
      .command('get')
      .description('Get a monitor by ID')
      .argument('<monitorId>', 'Monitor ID')
  ).action(async (monitorId, options) => {
    try {
      const payload = await monitorRequest(
        `/monitor/${encodeURIComponent(monitorId)}`,
        options
      );
      emit(payload, options);
    } catch (err) {
      fail(err);
    }
  });

  // update
  commonOptions(
    monitor
      .command('update')
      .description('Update a monitor (flags, or JSON from file/stdin)')
      .argument('<monitorId>', 'Monitor ID')
      .argument(
        '[file]',
        'Path to JSON payload (use "-" or pipe stdin to read from stdin)'
      )
      .option('--name <name>', 'New name')
      .option('--goal <goal>', 'New monitor goal')
      .option('--cron <expression>', 'New cron schedule')
      .option('--schedule <text>', 'New natural-language schedule')
      .option('--timezone <tz>', 'Schedule timezone')
      .option('--state <state>', 'active | paused')
      .option('--retention-days <n>', 'Snapshot retention window', parseInt)
  ).action(async (monitorId: string, file: string | undefined, options) => {
    try {
      const fromJson = await readJsonPayload(file);
      let body: Record<string, unknown>;
      if (fromJson) {
        body = fromJson as Record<string, unknown>;
      } else {
        body = {};
        if (options.name) body.name = options.name;
        if (options.goal) body.goal = options.goal;
        if (options.state) body.status = options.state;
        if (options.retentionDays !== undefined)
          body.retentionDays = options.retentionDays;
        if (options.cron || options.schedule || options.timezone) {
          const schedule: Record<string, unknown> = {};
          if (options.cron) schedule.cron = options.cron;
          if (options.schedule) schedule.text = options.schedule;
          if (options.timezone) schedule.timezone = options.timezone;
          body.schedule = schedule;
        }
        if (Object.keys(body).length === 0) {
          throw new Error(
            'Provide at least one field to update (or a JSON file / stdin payload)'
          );
        }
      }
      const payload = await monitorRequest(
        `/monitor/${encodeURIComponent(monitorId)}`,
        options,
        { method: 'PATCH', body }
      );
      emit(payload, options);
    } catch (err) {
      fail(err);
    }
  });

  // delete
  commonOptions(
    monitor
      .command('delete')
      .description('Delete a monitor')
      .argument('<monitorId>', 'Monitor ID')
  ).action(async (monitorId, options) => {
    try {
      const payload = await monitorRequest(
        `/monitor/${encodeURIComponent(monitorId)}`,
        options,
        { method: 'DELETE' }
      );
      emit(payload, options);
    } catch (err) {
      fail(err);
    }
  });

  // run
  commonOptions(
    monitor
      .command('run')
      .description('Trigger a check immediately')
      .argument('<monitorId>', 'Monitor ID')
  ).action(async (monitorId, options) => {
    try {
      const payload = await monitorRequest(
        `/monitor/${encodeURIComponent(monitorId)}/run`,
        options,
        { method: 'POST' }
      );
      emit(payload, options);
    } catch (err) {
      fail(err);
    }
  });

  // checks (list)
  commonOptions(
    monitor
      .command('checks')
      .description('List checks for a monitor')
      .argument('<monitorId>', 'Monitor ID')
      .option('--limit <n>', 'Maximum results', parseInt)
      .option('--offset <n>', 'Result offset', parseInt)
  ).action(async (monitorId, options) => {
    try {
      const payload = await monitorRequest(
        `/monitor/${encodeURIComponent(monitorId)}/checks`,
        options,
        { query: { limit: options.limit, offset: options.offset } }
      );
      emit(payload, options);
    } catch (err) {
      fail(err);
    }
  });

  // check (get one)
  commonOptions(
    monitor
      .command('check')
      .description('Get a specific check, with page-level results')
      .argument('<monitorId>', 'Monitor ID')
      .argument('<checkId>', 'Check ID')
      .option('--limit <n>', 'Max page results', parseInt)
      .option('--skip <n>', 'Skip page results', parseInt)
      .option(
        '--page-status <state>',
        'Filter page results: same, new, changed, removed, error'
      )
  ).action(async (monitorId, checkId, options) => {
    try {
      const payload = await monitorRequest(
        `/monitor/${encodeURIComponent(monitorId)}/checks/${encodeURIComponent(checkId)}`,
        options,
        {
          query: {
            limit: options.limit,
            skip: options.skip,
            status: options.pageStatus,
          },
        }
      );
      emit(payload, options);
    } catch (err) {
      fail(err);
    }
  });

  monitor.addHelpText(
    'after',
    `
Examples:
  $ firecrawl monitor create --name "Blog" \\
      --goal "Notify me when a new post is published" \\
      --schedule "every 30 minutes" \\
      --page https://example.com/blog \\
      --email alerts@example.com
  $ firecrawl monitor create monitor.json
  $ cat monitor.json | firecrawl monitor create
  $ firecrawl monitor list --limit 20
  $ firecrawl monitor get mon_abc123
  $ firecrawl monitor update mon_abc123 --state paused
  $ firecrawl monitor run mon_abc123
  $ firecrawl monitor checks mon_abc123 --limit 10
  $ firecrawl monitor check mon_abc123 chk_xyz --page-status changed
`
  );

  return monitor;
}
