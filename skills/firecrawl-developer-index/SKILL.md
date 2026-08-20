---
name: firecrawl-developer-index
description: |
  Search issues, merged pull requests, READMEs, and documentation. Use when the question is how a library or API behaves, what an error means, or whether a bug was fixed; prefer this over a general web page.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl-cli *)
---

# firecrawl developer

Answer a developer question from the primary source: the issue, the merged pull request that fixed it, or the README/docs passage that states the contract.

## Quick start

```bash
mkdir -p .firecrawl
firecrawl developer "how do I configure retries" --limit 10 -o .firecrawl/developer.json --json
jq -r '.results[] | .id, .url, .passages[].text' .firecrawl/developer.json
```

Run `firecrawl developer --help` for the full option list.

HTTP: `GET|POST https://api.firecrawl.dev/v2/search/developer`. MCP: `firecrawl_developer_search`. Each hit carries `id`, `url`, `passages`. Kind is the `id` prefix (`doc:`, `issue:`, `pull_request:`, `readme:`). Hits do not carry a `type` field.

**Done when:** the answer quotes a matched passage and cites its `url` (fall back to `url` when `title` is absent), or you have moved to the open web because the index had nothing to say.

## Tips

- Default first move is `firecrawl developer`. Use `search --categories developer` only when you are already running a web search and want developer hits in the same call (no passage control, no index filters).
- Literal error or stack trace: search the string plus the library name. On HTTP, `types=["issue","pull_request"]`. Strip paths, line numbers, and ids, then retry.
- API contract: `readme` and `doc` are authoritative. A merged PR supersedes an issue report. Never answer from an opening report alone.
- Scope last: search the whole index, then narrow with HTTP `types`, `repos`, or `sources`. If a scoped search is empty, read the echoed `indexed` flag before concluding the repo is missing.
- Repository filters (`language`, `topic`, `license`, `min_stars`, …) drop `doc` results unless you also pass `sources`. `types`, `repos`, `sources`, `passages`, and those repository filters are HTTP-only.
- Comparison, opinion, news, or an unindexed project: `firecrawl search`, then `firecrawl scrape`.

## See also

- [firecrawl-search](../firecrawl-search/SKILL.md) — open web, or `search --categories developer` in the same call
- [firecrawl-scrape](../firecrawl-scrape/SKILL.md) — full page when a hit is right but you need all of it
- [firecrawl-research-index](../firecrawl-research-index/SKILL.md) — papers, not this index
