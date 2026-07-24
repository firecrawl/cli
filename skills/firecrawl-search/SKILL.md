---
name: firecrawl-search
description: |
  Web search with full page content extraction. Use this skill whenever the user asks to search the web, find articles, research a topic, look something up, find recent news, discover sources, or says "search for", "find me", "look up", "what are people saying about", or "find articles about". Returns real search results with optional full-page markdown — not just snippets. Provides capabilities beyond Claude's built-in WebSearch.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl *)
---

# firecrawl search

Web search with optional content scraping. Returns search results as JSON, optionally with full page content.

## When to use

- You don't have a specific URL yet
- You need to find pages, answer questions, or discover sources
- First step in the [workflow escalation pattern](firecrawl-cli): search → scrape → map → crawl → interact

## Quick start

```bash
# Basic search
firecrawl search "your query" -o .firecrawl/result.json --json

# Search and scrape full page content from results
firecrawl search "your query" --scrape -o .firecrawl/scraped.json --json

# News from the past day
firecrawl search "your query" --sources news --tbs qdr:d -o .firecrawl/news.json --json
```

## Options

| Option                               | Description                                   |
| ------------------------------------ | --------------------------------------------- |
| `--limit <n>`                        | Max number of results                         |
| `--sources <web,images,news>`        | Source types to search                        |
| `--categories <github,research,pdf>` | Filter by category                            |
| `--tbs <qdr:h\|d\|w\|m\|y>`          | Time-based search filter                      |
| `--location`                         | Location for search results                   |
| `--country <code>`                   | Country code for search                       |
| `--scrape`                           | Also scrape full page content for each result |
| `--scrape-formats`                   | Formats when scraping (default: markdown)     |
| `-o, --output <path>`                | Output file path                              |
| `--json`                             | Output as JSON                                |

## Tips

- **`--scrape` fetches full content** — don't re-scrape URLs from search results. This saves credits and avoids redundant fetches.
- Always write results to `.firecrawl/` with `-o` to avoid context window bloat.
- Use `jq` to extract URLs or titles **with their 1-indexed positions** (you'll need the positions for feedback): `jq -r '.data.web | to_entries[] | "\(.key + 1)\t\(.value.url)"' .firecrawl/search.json`
- Naming convention: `.firecrawl/search-{query}.json` or `.firecrawl/search-{query}-scraped.json`

## Send feedback after every search (refunds 1 credit)

Search costs 2 credits. After you've actually used the results (or decided they were useless), send structured feedback with `firecrawl search-feedback <id>`. The first feedback per search refunds 1 credit and helps us improve search quality. **Do this once per search**, in the background, after you finish processing the results — it does not block your main task.

**Opt out:** if `FIRECRAWL_NO_SEARCH_FEEDBACK=1` (or `FIRECRAWL_DISABLE_SEARCH_FEEDBACK=1`) is set, the CLI silently skips the call and never sends anything. Respect that — do not try to work around it. (Team admins can also disable this server-side; the API will return `feedbackErrorCode: "TEAM_OPTED_OUT"` and the CLI will exit 0 silently.)

**Rules to know before you call this:**

- **Time window:** must be sent within ~2 minutes of the search. Late feedback is rejected.
- **`--missing-content` is the most important field.** It's a list of _specific pieces_ of content you expected but did not find. One topic per entry — do not pack multiple topics into one string. These aggregate across teams and tell us what to index next.
- **`--valuable-result-positions` marks which results were useful.** 1-indexed positions into `data.web` (web results only). **Be exhaustive** — list every result that was actually useful; unlisted results are treated as not useful, so a partial list corrupts the signal. Reserve `--valuable-sources` for useful URLs that were NOT in `data.web` (e.g. a page you found by following a result's link) — never report the same result in both.
- **Substantive content required** (zero-effort feedback is rejected with HTTP 400):
  - `good` → must include `--valuable-result-positions` or at least one `--valuable-sources` entry.
  - `partial` → must include `--valuable-result-positions`, `--valuable-sources`, or `--missing-content`.
  - `bad` → must include `--missing-content` or `--query-suggestions`.
- **Daily refund cap (per team, per UTC day, default 100 credits).** Once your team has been refunded 100 credits today, further submissions still record feedback but no longer refund credits. The response includes `creditsRefundedToday` / `dailyRefundCap` / `dailyCapReached`. **When `dailyCapReached: true`, stop calling `search-feedback` for the rest of the UTC day** — it won't refund anything and you're wasting bandwidth.
- **Idempotent:** re-submitting for the same search id returns success but no extra refund.
- **`--silent &`** is the right pattern — exit code 0 even on failure, so a rejected/expired call never crashes your pipeline.

Read the search response's `id`:

```bash
SEARCH_ID=$(jq -r '.id' .firecrawl/search-react-hooks.json)
```

Then send feedback. Pick the rating that matches what actually happened:

```bash
# Results were useful — positions 1 and 3 of data.web answered the question
firecrawl search-feedback "$SEARCH_ID" \
  --rating good \
  --valuable-result-positions "1,3" \
  --missing-content '[
    {"topic":"useDeferredValue","description":"No example of useDeferredValue with Suspense"},
    {"topic":"useTransition","description":"No coverage of useTransition for routing"}
  ]' \
  --query-suggestions "Boost react.dev for queries about react hooks" \
  --silent &

# Results were partially useful — multiple missing topics, one entry per topic
firecrawl search-feedback "$SEARCH_ID" \
  --rating partial \
  --missing-content '[
    {"topic":"useDeferredValue"},
    {"topic":"useTransition","description":"Need React 18+ examples"},
    {"topic":"Server Components hooks"}
  ]' \
  --silent &

# Quick form — repeat --missing-content or use comma-separated topics
firecrawl search-feedback "$SEARCH_ID" \
  --rating bad \
  --missing-content "official api reference: missing v2 endpoints" \
  --missing-content "code examples in python" \
  --silent &
```

**`--missing-content` accepts:**

- JSON array of `{topic, description?}` objects (richest, preferred)
- `"topic: description"` strings (shorthand)
- Plain `"topic1, topic2, topic3"` (when you only have topic names)
- Repeated `--missing-content` flags

`--silent` suppresses output and `&` runs it in the background so feedback never blocks you.

## See also

- [firecrawl-scrape](../firecrawl-scrape/SKILL.md) — scrape a specific URL
- [firecrawl-map](../firecrawl-map/SKILL.md) — discover URLs within a site
- [firecrawl-crawl](../firecrawl-crawl/SKILL.md) — bulk extract from a site
