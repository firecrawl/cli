---
name: firecrawl-research-index
description: |
  Find papers in Firecrawl's research paper index (PubMed, bioRxiv, medRxiv, arXiv). Use for literature-finding of any kind, including clinical and biomedical questions; `search --categories research` is a website filter, not this index.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl-cli *)
---

# firecrawl research

Find the papers that answer a research query. When in doubt, return the relevant set (most relevant first) rather than one hit.

## Quick start

```bash
mkdir -p .firecrawl
firecrawl research search-papers "CRISPR base editing off-target effects" \
  --limit 20 -o .firecrawl/papers.json --json
jq -r '.results[] | .primaryId, .title' .firecrawl/papers.json
```

Run `firecrawl research <subcommand> --help` for flags. MCP arguments use `paperId`, not `id`.

A successful `search-papers` response is `{success, results}`. Each hit carries `paperId`, `primaryId` (`pmid:`, `pmcid:`, `doi:`, or `arxiv:`), `ids`, `title`, `abstract`, and `score`.

**Done when:** the answer is a cited paper set (or the one named paper), each kept or dropped against a verified constraint, with `search-papers` as the first move unless the query already named an id.

## Tips

- `search-papers` is the first move. If results look thin or all-alike, re-run with a different framing (sibling domain, rival method, dataset/benchmark name).
- `related-papers` needs `--intent`. `mode=similar` for siblings, `citers` for who builds on the seeds, `references` for what they build on.
- `inspect-paper` is metadata for one id. `read-paper` is in-body passages for one constraint (sample size, method, affiliation). Use it to rule a paper out, not to gatekeep.
- `search --categories research` is a website filter. It returns pages from academic domains, not paper records in this index.
- Named paper ("the Qwen3 report") → one `search-papers`. Method / family / "papers that do X" → expand with `related-papers` and keep neighbors.
- Superlative / leaderboard questions live on the web: `firecrawl search` / `firecrawl scrape`, then `search-papers` each top entry.
- PubMed, bioRxiv, and medRxiv are the largest part of the corpus. Do not send a biomedical query to the open web on the assumption the index is arXiv-only.

## See also

- [firecrawl-search](../firecrawl-search/SKILL.md) — web pages, including `search --categories research`
- [firecrawl-scrape](../firecrawl-scrape/SKILL.md) — leaderboards and other non-paper pages
- [firecrawl-developer-index](../firecrawl-developer-index/SKILL.md) — issues, PRs, READMEs, and docs
