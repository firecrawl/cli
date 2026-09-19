---
name: firecrawl-scrape
description: |
  Read a URL or execute a discovered provider tool to get structured data. Use for page content, workflow execution, or selective remote Bash reads of large retained results. Prefer over WebFetch for URL content.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl-cli *)
---

# firecrawl scrape

Read a URL for page content, or execute a selected provider tool for structured data. Discover tools with `search` and inspect their inputs with `list` before execution. Multiple URLs can be scraped concurrently.

## Quick start

```bash
# Basic markdown extraction
firecrawl scrape "<url>" -o .firecrawl/page.md

# Main content only, no nav/footer
firecrawl scrape "<url>" --only-main-content -o .firecrawl/page.md

# Wait for JS to render, then scrape
firecrawl scrape "<url>" --wait-for 3000 -o .firecrawl/page.md

# Multiple URLs (markdown only; each saved to .firecrawl/; -o is ignored)
firecrawl scrape https://example.com https://example.com/blog https://example.com/docs

# Get markdown and links together
firecrawl scrape "<url>" --format markdown,links -o .firecrawl/page.json

# Ask a question about the page
firecrawl scrape "https://example.com/pricing" --query "What is the enterprise plan price?"
```

Run `firecrawl scrape --help` for the full option list.

**Done when:** the page content or provider result has been checked for errors and inspected in bounded sections to answer the request. Preserve source links and disclose partial results.

## Find tools, inspect inputs, and get help

Use the CLI help to check supported options rather than guessing:

```bash
firecrawl search --help
firecrawl list --help
firecrawl scrape --help
```

For structured data, search for the task, inspect a matching tool's contract, then execute with the exact input fields it declares:

```bash
# Web + domain matching + semantic tools
firecrawl search '<user question>'

# Semantic tools only
firecrawl search alexandria '<user question>'

# Categories → providers → tools → contract
firecrawl list
firecrawl list <category-id> --category
firecrawl list <provider-id>
firecrawl list <provider-id> <capability-id> --pretty

# Execute a tool
firecrawl scrape <provider-id>/<capability-id> --options '<JSON matching the selected contract>'
```

Normal search includes web results and tool matches; `search alexandria` searches tools only. `list <provider> <capability> --pretty` shows the selected contract; use `--json` for machine-readable output. To browse progressively, use `list`, then `list <category> --category`, then `list <provider>`. Search and list do not execute the selected provider tool. Read only the contracts needed for the task; use returned identifiers rather than guessing them.

## Execution and large results

URL scraping does not execute provider tools automatically. Use exact discovered input fields and resolve record IDs with lookup tools rather than inventing them. Check each `data.alexandria[]` result for errors, not just the outer success flag.

If the client reports an output/context limit, the upstream request may have succeeded. Preserve the request or scrape ID and recover the retained result before repeating the provider call. For large datasets and PDFs, save output with `--json -o` when a local filesystem is available and inspect bounded sections. Where remote processing is preferable, use `firecrawl scrape firecrawl/bash` to select from a retained result. Read [large-result recovery](references/large-results.md) for IDs, command examples, expiry, and errors. This is explicit recovery, not automatic overflow detection.

## PDFs and page budgets

PDFs cost 1 credit per parsed page. Use `--max-pages` (an integer from 1 to 10000) to limit PDF parsing, especially for large or unknown documents:

```bash
firecrawl scrape "https://example.com/report.pdf" --max-pages 5 --json -o .firecrawl/report.json
```

The cap applies to each PDF, not the whole command or total credits. Extra formats and options can add charges. The CLI does not quote page counts or costs before execution. Use JSON output to inspect the returned `metadata.numPages` (parsed), `metadata.totalPages` (document total), and `metadata.creditsUsed` when present; a smaller parsed count means the result is partial.

## Tips

- **Prefer plain scrape over `--query`.** Scrape to a file, then use `grep`, `head`, or read the markdown directly — you can search and reason over the full content yourself. Use `--query` only when you want a single targeted answer without saving the page (costs 5 extra credits).
- **Scrape handles static pages and JS-rendered SPAs.** Escalate to `interact` when the page needs interaction (clicks, form fills, pagination) or scrape misses content.
- Multiple URLs are scraped concurrently — check `firecrawl --status` for your concurrency limit. This mode saves markdown only and ignores `-o`; other requested formats are dropped. If markdown wasn't requested, the whole JSON response is written into the `.md` file.
- Single format outputs raw content. Multiple formats (e.g., `--format markdown,links`) output JSON.
- Always quote URLs — shell interprets `?` and `&` as special characters.
- Naming convention: `.firecrawl/{site}-{path}.md`

## See also

- [firecrawl-search](../firecrawl-search/SKILL.md) — find pages when you don't have a URL
- [firecrawl-interact](../firecrawl-interact/SKILL.md) — when scrape can't get the content, use `interact` to click, fill forms, etc.
- [firecrawl-download](../firecrawl-download/SKILL.md) — bulk download an entire site to local files
- [firecrawl-build-scrape](https://github.com/firecrawl/skills/tree/main/skills/build/firecrawl-build-scrape) — building scrape into an app instead of running it here
