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

**Done when:** the response is saved under `.firecrawl/`, results or an empty result set have been inspected and handled for the request, and eligible feedback is sent within the time window (unless opted out).

## Alexandria in normal search

The beta defaults to `web,alexandria` with domain-tool matching on. Preserve the user's location, marketplace, and constraints in the query; do not turn normal research into an artificial tool-discovery query. Inspect `data.web` and `data.tools` from the same response.

A tool match is not executed data. If it fits the task, read its inputs, coverage, `creditsCost`/`perRecord`, and access requirements in the JSON. Execute it with `firecrawl scrape --alexandria <provider/capability> --options '<input JSON>'`. All provider execution goes through Scrape; `search --scrape` only fetches web result content, not provider tools.

Use `find-tools` only for an explicitly requested tool set or a missing contract. It runs the `firecrawl/find-tools` meta tool through Scrape and never executes the tools it discovers. It accepts URLs or catalogue selectors; for “tools that can do X,” first use `search "X" --sources alexandria`, then narrow the returned providers with `find-tools --options '{"providers":["<returned-provider>"],"level":"tools","limit":100}'`.

If no returned tool covers the country/market/segment or required inputs, continue with ordinary web results. Do not exhaust the catalogue or pay for adjacent tools just to probe coverage. `--sources web` explicitly opts out of Alexandria; `--sources web --domain-tools` retains domain matches only.

## Receipts and failures

JSON output preserves the response and additive `receipt`, including empty results. Read `receipt.creditsUsed` for actual reported usage (zero is valid; missing means unknown) and `receipt.operationId` with `operationType: "search"` for the server search ID. Existing `id` and `creditsUsed` fields remain available. Search IDs identify results; they are not Alexandria client idempotency IDs.

Available IDs, credits, and retry timing print to stderr. Keep stderr separate from JSON stdout. Failed calls with `--json` or `-o` write structured errors before exiting nonzero; check the exit code and `success` before using the file. Empty successful searches still write the requested output and retain their metadata.

On rate limits, wait at least the returned retry delay when available; otherwise use bounded exponential backoff. API keys on one team share limits, which vary by plan and endpoint. Do not invent a universal requests-per-minute quota or infer zero billing from a missing receipt.

## Tips

- **`--highlights` on by default:** results are query-relevant excerpts, not full-page snippets. Use `--no-highlights` for the original snippets.
- **`--scrape` fetches full content** — reuse that content instead of re-scraping result URLs. This saves credits and avoids redundant fetches.
- Always write results to `.firecrawl/` with `-o` to avoid context window bloat.
- Use `jq` to extract URLs or titles: `jq -r '.data.web[].url' .firecrawl/search.json`
- Naming convention: `.firecrawl/search-{query}.json` or `.firecrawl/search-{query}-scraped.json`

## Send feedback after every search (refunds 1 credit)

Search costs 2 credits. After you've actually used the results (or decided they were useless), send structured feedback with `firecrawl search-feedback <id>`. The first feedback per search refunds 1 credit and helps us improve search quality. **Do this once per search**, in the background, after you finish processing the results — it does not block your main task.

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

Verify the search succeeded before reading its `id`. Empty successful searches preserve their JSON output; failed searches contain error output. The guard below only sends feedback for a successful response with an ID and nonempty results; call `search-feedback` only inside it:

```bash
# Send once per search. Rate honestly and replace the placeholder with the
# rating that matches what actually happened. The two fields shown
# satisfy the substantive-content rule for every rating.
if SEARCH_ID=$(jq -er 'select(.success == true and any(.data[]; length > 0)) | .id' .firecrawl/search-react-hooks.json); then
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
