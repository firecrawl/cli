---
name: firecrawl-search
description: |
  Web search with full page content. Use when no URL is known: finding sources, articles, or news. For papers use firecrawl-research-index; for library, API, error, or bug questions use firecrawl-developer-index.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl-cli *)
---

# firecrawl search

Search naturally using the user’s actual question. In the Alexandria beta, default search returns web results plus relevant Alexandria tools, with optional web content scraping.

## Quick start

```bash
# Basic search
firecrawl search "your query" -o .firecrawl/result.json --json

# Search and scrape full page content from results
firecrawl search "your query" --scrape -o .firecrawl/scraped.json --json

# News from the past day
firecrawl search "your query" --sources news --tbs qdr:d -o .firecrawl/news.json --json
```

Run `firecrawl search --help` for the full option list.

`--categories developer` weighs the developer index beside ordinary web results in this same call (no passage control, no index filters). `--categories research` is a website filter, not the paper index. Dedicated skills: [firecrawl-developer-index](../firecrawl-developer-index/SKILL.md) and [firecrawl-research-index](../firecrawl-research-index/SKILL.md).

**Done when:** the search response has been checked and processed for the request. Feedback is optional and is not a completion requirement.

## Alexandria in normal search

The beta defaults to `web,alexandria` with domain-tool matching on. Preserve the user's location, marketplace, and constraints in the query; do not turn normal research into an artificial tool-discovery query. Inspect `data.web` and `data.tools` from the same response.

A tool match is not executed data. If it fits the task, read its inputs, coverage, `creditsCost`/`perRecord`, and access requirements in the JSON. Execute it with `firecrawl scrape --alexandria <provider/capability> --options '<input JSON>'`. All provider execution goes through Scrape; `search --scrape` only fetches web result content, not provider tools.

Use `find-tools` only for an explicitly requested tool set or a missing contract. It runs the `firecrawl/find-tools` meta tool through Scrape and never executes the tools it discovers. It accepts URLs or catalogue selectors; for “tools that can do X,” first use `search "X" --sources alexandria`, then narrow the returned providers with `find-tools --options '{"providers":["<returned-provider>"],"level":"tools","limit":100}'`.

If no returned tool covers the country/market/segment or required inputs, continue with ordinary web results. Do not exhaust the catalogue or pay for adjacent tools just to probe coverage. `--sources web` explicitly opts out of Alexandria; `--sources web --domain-tools` retains domain matches only.

## Tips

- **`--highlights` on by default:** results are query-relevant excerpts, not full-page snippets. Use `--no-highlights` for the original snippets.
- **`--scrape` fetches full content** — reuse that content instead of re-scraping result URLs. This saves credits and avoids redundant fetches.
- Always write results to `.firecrawl/` with `-o` to avoid context window bloat.
- Use `jq` to extract URLs or titles: `jq -r '.data.web[].url' .firecrawl/search.json`
- Naming convention: `.firecrawl/search-{query}.json` or `.firecrawl/search-{query}-scraped.json`

## Optional feedback

Choose the feedback contract that matches the search job's authentication. A returned `metadata.feedback` invitation identifies the keyless submission endpoint and job ID. Do not send the keyless fields to the authenticated Search feedback route, or add credentials to submit feedback for a keyless job.

Keyless feedback is available for successful and failed jobs when the response includes a job reference. For an explicitly failed job, use observation `kind: "failure"` and `reason: "timeout"`, `"transport_error"`, `"proxy_error"`, or `"other"`; report only the error already returned. Keep the submission under 8 KiB including server defaults. Run `firecrawl feedback --help` for reason definitions and the complete contract. The server invitation states the daily allowance, shared per caller IP.

### Keyless Search

Use `firecrawl feedback search <jobId>` with `--rating`, `--task`, `--assessment`, and `--observations-file`. The task describes what the search needed to answer; the assessment describes how well it answered that task. Supply 1-20 observations:

- Useful or irrelevant results: `kind` and one-based `position` within the delivered group. `source` (`web`, `images`, or `news`) is required for multi-source jobs and otherwise defaults to `web`. Irrelevant results also require `reason`; see command help for allowed values.
- Missing information: `kind: "missing"` and `vertical`; `topic` is optional. `vertical` is optional on useful and irrelevant results. See command help for allowed verticals.
- Missing and irrelevant observations may include `knownSources`: up to 20 HTTP(S) URLs, only when already known. These identify absent content or the source that should have ranked instead. Unmentioned results are unassessed; a full ranking is not required.
- Every observation requires `detail` and `basis`: `output`, `source_comparison`, or `expectation`. A source comparison also requires `comparison: {reference, detail}`, with the correct content in `comparison.detail`. Use expectations for gaps that have not been verified against a source.

Task, assessment, and observation detail each require 10-2000 characters. Use only evidence already available. Do not ask the user to complete an interview, investigate further, guess missing content, or diagnose causes merely to submit feedback. An empty result set can support a missing-information observation if the response includes an eligible job reference.

One new submission is accepted per keyless identity per UTC day across Search, Scrape, Parse, API, MCP, and CLI. Job references expire after 24 hours. Feedback does not consume or restore operation allowance. Do not submit after every search or retry a daily-limit rejection in a loop. Client feedback flags do not suppress keyless invitations or submissions. Submitting feedback remains optional.

Run `firecrawl feedback --help` for the full evidence contract. Old instructions using `firecrawl search-feedback` require authentication and do not work for keyless jobs.

### Authenticated Search

Authenticated callers can continue using `firecrawl search-feedback <id>` with `--valuable-sources`, `--missing-content`, and `--query-suggestions`. Its existing validation, feedback window, and refund policy are unchanged. If submitting, do so after processing the results, at most once per search, using only evidence already available.

**Opt out:** if `FIRECRAWL_NO_SEARCH_FEEDBACK=1` (or `FIRECRAWL_DISABLE_SEARCH_FEEDBACK=1`) is set, the CLI silently skips the call and never sends anything. Respect that — do not try to work around it. (Team admins can also disable this server-side; the API will return `feedbackErrorCode: "TEAM_OPTED_OUT"` and the CLI will exit 0 silently.)

**Rules to know before you call this:**

- **Time window:** must be sent within ~2 minutes of the search. Late feedback is rejected.
- **`--missing-content` is the most important field.** It's a list of _specific pieces_ of content you expected but did not find. One topic per entry, each in its own string. These aggregate across teams and tell us what to index next.
- **Substantive content required** (zero-effort feedback is rejected with HTTP 400):
  - `good` → must include at least one `--valuable-sources` entry.
  - `partial` → must include `--valuable-sources` or `--missing-content`.
  - `bad` → must include `--missing-content` or `--query-suggestions`.
- **Daily refund cap (per team, per UTC day, default 100 credits).** Once your team has been refunded 100 credits today, further submissions still record feedback but no longer refund credits. The response includes `creditsRefundedToday` / `dailyRefundCap` / `dailyCapReached`. **When `dailyCapReached: true`, stop calling `search-feedback` for the rest of the UTC day** — it won't refund anything and you're wasting bandwidth.
- **Idempotent:** re-submitting for the same search id returns success but no extra refund.
- **`--silent &`** is the right pattern — exit code 0 even on failure, so a rejected/expired call never crashes your pipeline.

Verify the search returned results before reading its `id`. Zero-result searches write no output file, so the file may be missing — or left over from an earlier search. The guard below skips feedback when the file is missing or has zero results; call `search-feedback` only inside it:

```bash
# Send once per search. Rate honestly and replace the placeholder with the
# rating that matches what actually happened. The two fields shown
# satisfy the substantive-content rule for every rating.
if SEARCH_ID=$(jq -er 'select(any(.data[]; length > 0)) | .id' .firecrawl/search-react-hooks.json); then
  firecrawl search-feedback "$SEARCH_ID" \
    --rating "<good|partial|bad>" \
    --valuable-sources '[{"url":"https://react.dev/reference/react/hooks","reason":"Most authoritative"}]' \
    --missing-content '[{"topic":"useDeferredValue","description":"No example of useDeferredValue with Suspense"}]' \
    --silent &
fi
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
- [firecrawl-developer-index](../firecrawl-developer-index/SKILL.md) — issues, merged PRs, READMEs, and docs
- [firecrawl-research-index](../firecrawl-research-index/SKILL.md) — published papers, not `search --categories research`
- [firecrawl-build-search](https://github.com/firecrawl/skills/tree/main/skills/build/firecrawl-build-search) — building search into an app instead of running it here
