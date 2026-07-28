---
name: firecrawl-download
description: |
  Download an entire website as local files — markdown, screenshots, or multiple formats per page. Use this skill when the user wants to save a site locally, download documentation for offline use, bulk-save pages as files, or says "download the site", "save as local files", "offline copy", "download all the docs", or "save for reference". Combines site mapping and scraping into organized local directories.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl *)
---

# firecrawl experimental download

> **Experimental.** Convenience command that combines `map` + `scrape` to save an entire site as local files. Registered under `firecrawl experimental download`, with `firecrawl x download` as the short alias.

Maps the site first to discover pages, then scrapes each one into nested directories under `.firecrawl/`. A subset of scrape options is supported (listed below). Always pass `-y` to skip the confirmation prompt.

## When to use

- You want to save an entire site (or section) to local files
- You need offline access to documentation or content
- Bulk content extraction with organized file structure

## Quick start

```bash
# Interactive wizard (picks format, screenshots, paths for you)
firecrawl x download https://docs.example.com

# With screenshots
firecrawl x download https://docs.example.com --screenshot --limit 20 -y

# Multiple formats (each saved as its own file per page)
firecrawl x download https://docs.example.com --format markdown,links --screenshot --limit 20 -y
# Creates per page: index.md + links.txt + screenshot.png

# Filter to specific sections
firecrawl x download https://docs.example.com --include-paths "/features,/sdks"

# Skip translations
firecrawl x download https://docs.example.com --exclude-paths "/zh,/ja,/fr,/es,/pt-BR"

# Full combo
firecrawl x download https://docs.example.com \
  --include-paths "/features,/sdks" \
  --exclude-paths "/zh,/ja" \
  --only-main-content \
  --screenshot \
  -y
```

## Download options

| Option                    | Description                                              |
| ------------------------- | -------------------------------------------------------- |
| `--limit <n>`             | Max pages to download                                    |
| `--search <query>`        | Filter URLs by search query                              |
| `--include-paths <paths>` | Only download matching paths                             |
| `--exclude-paths <paths>` | Skip matching paths                                      |
| `--allow-subdomains`      | Include subdomain pages                                  |
| `-y`                      | Skip confirmation prompt (always use in automated flows) |

## Scrape options supported by download

Only these scrape options are registered on the download command:

`-f <formats>` (markdown, html, rawHtml, links, images, summary, json), `-H, --html`, `-S, --summary`, `--screenshot`, `--full-page-screenshot`, `--only-main-content`, `--include-tags`, `--exclude-tags`, `--wait-for`, `--max-age`, `--country`, `--languages`, `--lockdown`

## See also

- [firecrawl-map](../firecrawl-map/SKILL.md) — just discover URLs without downloading
- [firecrawl-scrape](../firecrawl-scrape/SKILL.md) — scrape individual pages
- [firecrawl-crawl](../firecrawl-crawl/SKILL.md) — bulk extract as JSON (not local files)
