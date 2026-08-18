---
name: firecrawl-monitor
description: >-
  Monitor pages or the web for changes or new results and send notifications by
  email or webhook on a recurring schedule. Use for page monitoring, web
  monitoring, recurring checks, alerts, or requests to monitor, watch, or track
  a URL or topic. Covers competitor pricing, jobs, blogs, docs, changelogs, and
  status pages, plus new product launches, funding rounds, papers, news,
  releases, and mentions across the web. Prefer monitors over repeated scrapes
  whenever content must be checked more than once; use page monitors for known
  URLs and web monitors with search queries plus a goal for new results.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl-cli *)
---

# firecrawl monitor

Detect when content on a website changes and get notified by webhook or email. Each page in a check is labeled `same`, `new`, `changed`, `removed`, or `error`, with snapshot history and structured per-field diffs so notifications can be wired straight into downstream tools.

Monitors come in two flavors: **page monitors** watch URLs you already have (a page, a list, or a whole site via crawl) for changes, and **web monitors** watch the whole web via search for _new_ results that match a goal — see [Web monitors](#web-monitors-monitor-the-web).

**Pick a target mode** by what you're watching:

| Mode        | Flags                          | Watches                                                |
| ----------- | ------------------------------ | ------------------------------------------------------ |
| Single page | `--page <url>`                 | one URL, for changes                                   |
| URL batch   | `--scrape-urls <url,url,...>`  | several URLs, for changes                              |
| Whole site  | `--crawl-url <root-url>`       | every page a crawl discovers, for changes              |
| Web search  | `--queries <q,...>` + `--goal` | the **whole web**, for _new_ results matching the goal |

The first three watch URLs you already have. **Web search** is the odd one out — there's no fixed URL; it runs your queries each check and alerts on results it hasn't seen before. `--goal` is required with `--queries`. (See [Web monitors](#web-monitors-monitor-the-web).)

## When to use

- The user wants to know **when** something changes — and be **notified about it** — not just read what the page says right now
- Ongoing change detection on any URL: pricing, docs, changelogs, blogs, job boards, status pages, competitor sites, regulatory pages, product availability, hiring pages, top-N rankings (HN, leaderboards, etc.)
- **Monitoring the web** for _new_ results rather than changes to a known page — new launches, funding rounds, papers, news, releases, or brand mentions surfaced by search across the whole web (a **web monitor**: `--queries` + `--goal`)
- "Alert me when...", "notify me when...", "email me if...", "send a webhook when...", "ping me if X changes", "track this page", "monitor the web for...", "watch for new..."
- Anywhere the user would otherwise wire up cron + a scraper + a diff library + SMTP themselves
- Step 5 in the [workflow escalation pattern](../firecrawl/SKILL.md): search → scrape → map + scrape → crawl → **monitor** → interact

**Bias toward `monitor`** whenever the request implies notifications or recurrence. A single page read once = `scrape`. A single page where the user wants to be told when it changes = `monitor --page <url> --goal "..." --email|--webhook-url ...`.

## Why use a monitor

- **Change-detection-as-a-service.** Firecrawl handles fetching, diffing, judging, and notifying — all server-side. No cron, no diff library, no SMTP setup, no snapshot DB to manage.
- **Notifications first.** Webhooks (`monitor.page` as each page finishes, `monitor.check.completed` after the check is reconciled) and email summaries that only fire when something actually changed or errored. External recipients confirm via per-recipient opt-in.
- **AI noise filter via `--goal`.** Set a plain-language goal and the change judge ignores formatting, whitespace, casing, punctuation, encoding, request/session IDs, cache busters, tracking params, generic metadata, and unrelated page chrome — so notifications are about content the user actually cares about, not page churn.
- **Structured per-field diffs.** JSON-mode change tracking returns keyed diffs like `plans[0].price: "$19/mo" → "$24/mo"` instead of a wall of unified diff. Drops straight into a Slack message, CI step, or internal tool.
- **Simple page-status model.** Each page in a check returns `same`, `new`, `changed`, `removed`, or `error`. Easy to filter, easy to act on.
- **Snapshot history without infra.** Point-in-time snapshots are kept for diffing via `--retention-days`; no storage to provision.
- **Watch many things at once.** One monitor can watch many pages or diff every page discovered by a recurring site crawl.
- **No scheduling glue.** Cron normalization and `nextRunAt` are computed for you, with natural-language schedules supported (`"every 30 minutes"`, `"hourly"`, `"daily at 9:00"`).

## Quick start

```bash
# Single page, natural-language schedule, email alert
firecrawl monitor create --name "Blog" --schedule "every 30 minutes" \
  --goal "Alert when a new blog post is published." \
  --page https://example.com/blog \
  --email alerts@example.com

# Multiple pages, one monitor
firecrawl monitor create --name "Product pages" --schedule "every 30 minutes" \
  --goal "Alert when pricing, docs, or changelog content changes." \
  --scrape-urls https://example.com/pricing,https://example.com/docs,https://example.com/changelog

# Whole-site crawl per check (every discovered page is diffed)
firecrawl monitor create --name "Docs site" --schedule "hourly" \
  --goal "Alert when any docs page is added, removed, or substantively changed." \
  --crawl-url https://docs.example.com

# Web monitor — search the whole web for NEW results matching a goal (--goal required)
firecrawl monitor create --name "Competitor launches" --schedule "daily at 9:00" \
  --queries "competitor product launch,competitor funding round" \
  --goal "Alert when a competitor announces a new product or raises funding." \
  --search-window 7d --max-results 20 \
  --email alerts@example.com

# Webhook notifications
firecrawl monitor create --name "Docs webhook" --schedule "every 30 minutes" \
  --goal "Alert when docs content changes." \
  --page https://example.com/docs \
  --webhook-url https://example.com/hook \
  --webhook-events monitor.page,monitor.check.completed

# Manage and inspect
firecrawl monitor list --limit 20
firecrawl monitor get <monitorId>
firecrawl monitor run <monitorId>             # trigger a check now
firecrawl monitor checks <monitorId>          # list all checks
firecrawl monitor check <monitorId> <checkId> --page-status changed
firecrawl monitor update <monitorId> --state paused
firecrawl monitor delete <monitorId>
```

Subcommands: `create | list | get | update | delete | run | checks | check`.

## Options

| Option                     | Description                                                               |
| -------------------------- | ------------------------------------------------------------------------- |
| `--name <name>`            | Monitor name (required on create)                                         |
| `--goal <text>`            | Plain-language change goal (auto-enables the AI change judge)             |
| `--schedule <text>`        | Natural-language schedule (`every 30 minutes`, `hourly`, `daily`)         |
| `--cron <expression>`      | Cron schedule (e.g. `*/30 * * * *`)                                       |
| `--timezone <tz>`          | Schedule timezone (default: `UTC`)                                        |
| `--page <url>`             | Single page URL to scrape on each check                                   |
| `--scrape-urls <list>`     | Comma-separated URLs to scrape on each check                              |
| `--crawl-url <url>`        | Root URL for a crawl target (every discovered page gets diffed)           |
| `--queries <list>`         | Comma-separated search queries for a **web monitor** (requires `--goal`)  |
| `--search-window <window>` | Web-monitor recency: `5m`, `15m`, `1h`, `6h`, `24h`, `7d` (default `24h`) |
| `--max-results <n>`        | Web-monitor results per query, 1–50 (default `10`)                        |
| `--include-domains <list>` | Restrict web-monitor results to these domains (comma-separated)           |
| `--exclude-domains <list>` | Exclude these domains from web-monitor results (comma-separated)          |
| `--webhook-url <url>`      | Webhook destination                                                       |
| `--webhook-events <list>`  | `monitor.page`, `monitor.check.completed` (comma-separated)               |
| `--email <list>`           | Comma-separated email recipients                                          |
| `--retention-days <n>`     | Snapshot retention window                                                 |
| `--state <state>`          | `active` or `paused` (update only — use `--state`, not `--status`)        |
| `--page-status <state>`    | Filter `check` results: `same`, `new`, `changed`, `removed`, `error`      |
| `--limit <n>`              | Max results (`list`, `checks`) or page results (`check`)                  |
| `--offset <n>`             | Result offset (`list`, `checks`)                                          |
| `--skip <n>`               | Page-result offset (`check`)                                              |
| `-o, --output <path>`      | Output file path                                                          |
| `--pretty`                 | Pretty-print JSON output                                                  |

Minimum schedule interval is **5 minutes**. Monitoring is **not available for zero-data-retention teams**.

## Web monitors (monitor the web)

Page and crawl monitors watch URLs you already have. A **web monitor** watches the whole web instead: give it search queries and a goal, and each check runs the searches, judges every result against your goal, and alerts you on **new** results you haven't seen before. Reach for it when there's no URL to bookmark yet — new product launches, funding rounds, papers, news, releases, or brand mentions.

```bash
firecrawl monitor create --name "AI model releases" --schedule "daily at 9:00" \
  --queries "new AI model release,frontier model launch" \
  --goal "Alert when a major lab releases a new AI model. Ignore tutorials and listicles." \
  --search-window 7d --max-results 20 \
  --webhook-url https://example.com/hook
```

- **`--queries` and `--goal` are both required.** Queries are comma-separated; the goal is what the AI judge scores each result against, so only on-topic results alert you.
- **`--search-window`** sets recency — `5m`, `15m`, `1h`, `6h`, `24h`, `7d` (default `24h`). Widen it for niche topics that don't publish often.
- **`--max-results`** caps results per query, 1–50 (default `10`).
- **`--include-domains` / `--exclude-domains`** restrict or exclude sources (comma-separated).
- **Result model:** web-monitor results are labeled `new` (first time seen) or `same` (already seen on a prior check) — never `changed`/`removed`. Dedup means a result alerts you **once**, when it first appears. Webhooks and email work exactly as they do for page monitors.
- The [`--goal` guidance](#writing-a-good---goal) below applies: state what counts as a match in plain language and add `Ignore ...` only for intent-specific exclusions.

## Writing good `--queries` (web monitors)

For a web monitor, **queries control recall** (what the search retrieves) and **the goal controls precision** (which results alert). Tune both — a perfect goal can't alert on a result the queries never pulled in, and broad queries with a vague goal produce constant low-value alerts.

- Write **keywords, not sentences**: `OpenAI new model release`, not `tell me when OpenAI releases a new model`.
- Quote multi-word entities (`"Llama 4"`); group synonyms with `OR` (`launch OR release OR announcement`).
- Keep each query tight (~2–6 terms). One broad query usually beats several narrow ones — extra queries split the `--max-results` budget without adding coverage.
- One query per **distinct** subject. Several facets of one subject = one query; only split for genuinely separate entities (e.g. "OpenAI, Anthropic, and Google").
- No `site:` operators in queries — use `--include-domains` / `--exclude-domains`.

**What good looks like:** a healthy web monitor mostly returns `new: 0` and alerts only on genuinely new, on-goal results. If many retrieved results are off-goal, the queries pull noise the goal rejects — tighten the queries. If a topic returns nothing for long stretches, the queries are too narrow or `--search-window` too tight — broaden them. If the user dismisses alerts, the goal is too broad — add an intent-specific `Ignore ...`. The aim is high precision with enough recall: every alert worth acting on, nothing real missed.

## Writing a good `--goal`

The goal is what the AI change judge uses to decide whether a page is `changed` vs `same`. Convert the user's intent into a concise 2-3 sentence goal:

- Start with `Alert when ...` and state the trigger using the user's wording.
- Restate any scope they mentioned: top N, price, role type, region, company, topic, status, or a specific entity.
- Add an `Ignore ...` sentence **only** for intent-specific exclusions (e.g. points/comments for rankings, marketing copy for pricing, general company-page updates for job listings).
- Do **not** repeat generic noise exclusions — the judge already handles whitespace, casing, punctuation, encoding, formatting-only changes, request/session IDs, cache busters, tracking params, generic metadata noise, and unrelated page chrome.
- Don't invent page-specific sections, entities, thresholds, exclusions, or business rules unless the user mentioned them.
- If the user is vague or asks for "any change", keep the goal broad and don't add exclusions.

| User says                   | Good goal                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `top 10 hackernews stories` | `Alert when stories enter, leave, or change rank within the Hacker News top 10. Ignore points, comments, and timestamps. Do not alert on changes outside the top 10.` |
| `pricing changes`           | `Alert when pricing information changes, including prices, plan names, billing periods, tiers, limits, or included features. Ignore unrelated marketing copy.`        |
| `new engineering roles`     | `Alert when a new engineering role is posted. Ignore general company-page updates unless they add, remove, or change an engineering role.`                            |
| `track this page`           | `Alert when substantive visible content on this page changes.`                                                                                                        |
| `any change`                | `Alert when any visible page content changes, including copy, numbers, timestamps, counters, links, and layout text.`                                                 |

## JSON-mode change tracking (structured per-field diffs)

By default monitors diff each page's markdown and return a unified text diff. When the user cares about **specific structured fields** (price, headline, in-stock flag, items in a list), use JSON-mode change tracking. The CLI flags don't cover this — pass a JSON body via positional file or piped stdin:

```bash
cat > pricing-monitor.json <<'EOF'
{
  "name": "Pricing watch",
  "goal": "Alert when plan prices or headline features change.",
  "schedule": { "text": "hourly", "timezone": "UTC" },
  "targets": [{
    "type": "scrape",
    "urls": ["https://example.com/pricing"],
    "scrapeOptions": {
      "formats": [{
        "type": "changeTracking",
        "modes": ["json"],
        "prompt": "Extract pricing tiers and headline features for each plan.",
        "schema": {
          "type": "object",
          "properties": {
            "plans": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name":     { "type": "string" },
                  "price":    { "type": "string" },
                  "features": { "type": "array", "items": { "type": "string" } }
                }
              }
            }
          }
        }
      }]
    }
  }]
}
EOF
firecrawl monitor create pricing-monitor.json
# or: cat pricing-monitor.json | firecrawl monitor create
```

Each changed page in the check response then carries a per-field diff plus a snapshot of the current full extraction:

```json
{
  "url": "https://example.com/pricing",
  "status": "changed",
  "diff": {
    "json": {
      "plans[0].price": { "previous": "$19/mo", "current": "$24/mo" },
      "plans[1].features[2]": {
        "previous": "10 GB storage",
        "current": "25 GB storage"
      }
    }
  },
  "snapshot": {
    "json": {
      "plans": [
        /* current full extraction */
      ]
    }
  }
}
```

Use `modes: ["json", "git-diff"]` for **mixed mode** — you get both `diff.json` (per-field) and `diff.text` (markdown sidecar), and the page is marked `changed` whenever either surface changed.

## Tips

- **Prefer one monitor over repeated one-off scrapes** whenever the user wants the same URL checked more than once.
- **Use `--state paused` (via `update`), not `delete`**, when temporarily silencing a monitor.
- **`--retention-days`** controls how long snapshots are kept for diffing. Lower it for high-frequency monitors to save storage.
- **External email recipients must opt in.** First time they're added, Firecrawl sends a confirmation email and they only receive alerts after they confirm. Team-owned email addresses are auto-confirmed. Once a recipient unsubscribes, they must be re-added by the owner to get a fresh confirmation email.
- **`firecrawl monitor run <id>`** triggers a check immediately — useful for smoke-testing a monitor right after creating it without waiting for the next scheduled run.
- **Filter check pages** with `--page-status changed` (or `new`, `removed`, `error`) to skip the noise from `same` pages.
- **Use `--page-status` (not `--status`)** when filtering check pages — `--status` is reserved for the global CLI status flag.
- **Monitor-triggered scrapes default `maxAge` to `0`** — every check performs a fresh scrape unless `scrapeOptions.maxAge` is set explicitly in a JSON payload.

## See also

- [firecrawl-scrape](../firecrawl-scrape/SKILL.md) — one-off scrape; escalate to `monitor` when checks become recurring
- [firecrawl-crawl](../firecrawl-crawl/SKILL.md) — one-off crawl; pair with `--crawl-url` here for recurring crawl diffs
- [firecrawl](../firecrawl/SKILL.md) — top-level workflow guide
