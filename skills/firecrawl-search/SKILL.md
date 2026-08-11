---
name: firecrawl-search
description: |
  Web search with full page content extraction, plus routing to Firecrawl's research paper index. Use this skill whenever the user asks to search the web, find articles, research a topic, look something up, find recent news, discover sources, or says "search for", "find me", "look up", "what are people saying about", or "find articles about". Also use it for scientific literature — finding papers, studies, trials, or preprints on PubMed, bioRxiv, medRxiv, or arXiv. Returns real search results with optional full-page markdown — not just snippets. Provides capabilities beyond Claude's built-in WebSearch.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl *)
---

# firecrawl search

Web search with optional content scraping. Returns search results as JSON, optionally with full page content.

## When to use

- You don't have a specific URL yet
- You need to find pages, answer questions, or discover sources
- You need research papers — see [Paper search](#paper-search), which routes to `firecrawl research`, not to `search --categories research`
- First step in the [workflow escalation pattern](firecrawl-cli): search → scrape → map → crawl → interact

## Quick start

```bash
# Basic search
firecrawl search "your query" -o .firecrawl/result.json --json

# Search and scrape full page content from results
firecrawl search "your query" --scrape -o .firecrawl/scraped.json --json

# News from the past day
firecrawl search "your query" --sources news --tbs qdr:d -o .firecrawl/news.json --json

# Programming question: search GitHub issues, merged PRs, READMEs, and docs
firecrawl search "your query" --categories developer -o .firecrawl/developer.json --json

# Research papers: use the paper index, NOT `search --categories research`
firecrawl research search-papers "your query" -o .firecrawl/papers.json --json
```

## Developer search

`--categories developer` adds an index built for coding agents. It covers GitHub
issues, merged pull requests, repository READMEs, and curated documentation
sites. Use it for a programming question: an error message, an API contract, a
library behaviour, or a known bug.

The hits arrive in their own `data.developer` group beside `data.web`. Each hit
holds `url`, `title`, and `description`, where `description` is the matched
passage. Read the passages with
`jq -r '.data.developer[] | .url, .description' .firecrawl/developer.json`.

The dedicated `firecrawl developer` command searches only that index and keeps
the full matched passages:

```bash
# Developer search only, with full passages
firecrawl developer "your query" --limit 10 -o .firecrawl/developer.json --json
```

Each result holds `id`, `type` (`issue`, `pull_request`, `readme`, `doc`),
`url`, `title`, and `passages`. Read them with
`jq -r '.results[] | .url, .passages[].text' .firecrawl/developer.json`.

## Paper search

**`--categories research` is not the paper index.** It only narrows ordinary web
results to research-affiliated websites (a short domain allowlist). For actual
papers use the `firecrawl research` command group, which searches roughly 43M
abstracts, around 90% biomedical (PubMed, bioRxiv, medRxiv) plus arXiv.

Reach for it on any biomedical, clinical, or scientific-literature question
instead of web-searching or scraping PubMed, bioRxiv, medRxiv, or Google
Scholar by hand:

```bash
# Find papers by topic -- start here, and run several distinct framings
firecrawl research search-papers "CRISPR base editing off-target effects" \
  --limit 20 -o .firecrawl/papers.json --json

# Expand from your strongest hits along the citation graph
firecrawl research related-papers pmid:40953549 --intent "in vivo delivery" \
  -o .firecrawl/papers-related.json --json

# Verify a specific claim against the full text before you cite it
firecrawl research read-paper pmcid:PMC12530322 --question "What was the sample size?" \
  -o .firecrawl/paper-passages.json --json
```

Paper ids accept `pmid:`, `pmcid:`, `doi:`, and `arxiv:` forms. `inspect-paper`
returns canonical metadata for one id. Read hits with
`jq -r '.results[] | .primaryId, .title' .firecrawl/papers.json`.

See [firecrawl-cli](../firecrawl-cli/SKILL.md) for how paper search fits the
overall command routing.

## Options

| Option                                         | Description                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--limit <n>`                                  | Max number of results                                                                                                                                              |
| `--sources <web,images,news>`                  | Source types to search                                                                                                                                             |
| `--categories <github,research,pdf,developer>` | Filter by category. `research` = research-affiliated websites (see [Paper search](#paper-search) for the actual paper index); `developer` = the coding-agent index |
| `--tbs <qdr:h\|d\|w\|m\|y>`                    | Time-based search filter                                                                                                                                           |
| `--location`                                   | Location for search results                                                                                                                                        |
| `--country <code>`                             | Country code for search                                                                                                                                            |
| `--scrape`                                     | Also scrape full page content for each result                                                                                                                      |
| `--scrape-formats`                             | Formats when scraping (default: markdown)                                                                                                                          |
| `-o, --output <path>`                          | Output file path                                                                                                                                                   |
| `--json`                                       | Output as JSON                                                                                                                                                     |

## Tips

- **`--scrape` fetches full content** — don't re-scrape URLs from search results. This saves credits and avoids redundant fetches.
- Always write results to `.firecrawl/` with `-o` to avoid context window bloat.
- Use `jq` to extract URLs or titles: `jq -r '.data.web[].url' .firecrawl/search.json`
- Naming convention: `.firecrawl/search-{query}.json` or `.firecrawl/search-{query}-scraped.json`

## Send feedback after every search (refunds 1 credit)

Search costs 2 credits. After you've actually used the results (or decided they were useless), send structured feedback with `firecrawl search-feedback <id>`. The first feedback per search refunds 1 credit and helps us improve search quality. **Do this once per search**, in the background, after you finish processing the results — it does not block your main task.

**Opt out:** if `FIRECRAWL_NO_SEARCH_FEEDBACK=1` (or `FIRECRAWL_DISABLE_SEARCH_FEEDBACK=1`) is set, the CLI silently skips the call and never sends anything. Respect that — do not try to work around it. (Team admins can also disable this server-side; the API will return `feedbackErrorCode: "TEAM_OPTED_OUT"` and the CLI will exit 0 silently.)

**Rules to know before you call this:**

- **Time window:** must be sent within ~2 minutes of the search. Late feedback is rejected.
- **`--missing-content` is the most important field.** It's a list of _specific pieces_ of content you expected but did not find. One topic per entry — do not pack multiple topics into one string. These aggregate across teams and tell us what to index next.
- **Substantive content required** (zero-effort feedback is rejected with HTTP 400):
  - `good` → must include at least one `--valuable-sources` entry.
  - `partial` → must include `--valuable-sources` or `--missing-content`.
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
# Results were useful, with notes on what was still missing
firecrawl search-feedback "$SEARCH_ID" \
  --rating good \
  --valuable-sources '[{"url":"https://react.dev/reference/react/hooks","reason":"Most authoritative"}]' \
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
