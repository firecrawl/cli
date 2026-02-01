# 🔥 Firecrawl CLI

Command-line interface for Firecrawl. Scrape, crawl, and extract data from any website directly from your terminal.

## Installation

```bash
npm install -g firecrawl-cli
```

If you are using in any AI agent like Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Github Copilot, Antigravity, etc. you can install the skill with:

```bash
npx skills add firecrawl/cli
```

(Alternative method) If you are using Claude code you can also install via the plugin marketplace:

```bash
/plugin marketplace add firecrawl/cli
/plugin install firecrawl
```

## Quick Start

Just run a command - the CLI will prompt you to authenticate if needed:

```bash
firecrawl https://example.com
```

## Authentication

On first run, you'll be prompted to authenticate:

```
  🔥 firecrawl cli
  Turn websites into LLM-ready data

Welcome! To get started, authenticate with your Firecrawl account.

  1. Login with browser (recommended)
  2. Enter API key manually

Tip: You can also set FIRECRAWL_API_KEY environment variable

Enter choice [1/2]:
```

### Authentication Methods

```bash
# Interactive (prompts automatically when needed)
firecrawl

# Browser login
firecrawl login

# Direct API key
firecrawl login --api-key fc-your-api-key

# Environment variable
export FIRECRAWL_API_KEY=fc-your-api-key

# Per-command API key
firecrawl scrape https://example.com --api-key fc-your-api-key
```

### Self-hosted / Local Development

For self-hosted Firecrawl instances or local development, use the `--api-url` option:

```bash
# Use a local Firecrawl instance (no API key required)
firecrawl --api-url http://localhost:3002 scrape https://example.com

# Or set via environment variable
export FIRECRAWL_API_URL=http://localhost:3002
firecrawl scrape https://example.com

# Self-hosted with API key
firecrawl --api-url https://firecrawl.mycompany.com --api-key fc-xxx scrape https://example.com
```

When using a custom API URL (anything other than `https://api.firecrawl.dev`), authentication is automatically skipped, allowing you to use local instances without an API key.

---

## Commands

### `scrape` - Scrape a single URL

Extract content from any webpage in various formats.

```bash
# Basic usage (outputs markdown)
firecrawl https://example.com
firecrawl scrape https://example.com

# Get raw HTML
firecrawl https://example.com --html
firecrawl https://example.com -H

# Multiple formats (outputs JSON)
firecrawl https://example.com --format markdown,links,images

# Save to file
firecrawl https://example.com -o output.md
firecrawl https://example.com --format json -o data.json --pretty
```

#### Scrape Options

| Option                   | Description                                             |
| ------------------------ | ------------------------------------------------------- |
| `-f, --format <formats>` | Output format(s), comma-separated                       |
| `-H, --html`             | Shortcut for `--format html`                            |
| `--only-main-content`    | Extract only main content (removes navs, footers, etc.) |
| `--wait-for <ms>`        | Wait time before scraping (for JS-rendered content)     |
| `--screenshot`           | Take a screenshot                                       |
| `--include-tags <tags>`  | Only include specific HTML tags                         |
| `--exclude-tags <tags>`  | Exclude specific HTML tags                              |
| `-o, --output <path>`    | Save output to file                                     |
| `--pretty`               | Pretty print JSON output                                |
| `--timing`               | Show request timing info                                |

#### Available Formats

| Format       | Description                |
| ------------ | -------------------------- |
| `markdown`   | Clean markdown (default)   |
| `html`       | Cleaned HTML               |
| `rawHtml`    | Original HTML              |
| `links`      | All links on the page      |
| `screenshot` | Screenshot as base64       |
| `json`       | Structured JSON extraction |

#### Examples

```bash
# Extract only main content as markdown
firecrawl https://blog.example.com --only-main-content

# Wait for JS to render, then scrape
firecrawl https://spa-app.com --wait-for 3000

# Get all links from a page
firecrawl https://example.com --format links

# Screenshot + markdown
firecrawl https://example.com --format markdown --screenshot

# Extract specific elements only
firecrawl https://example.com --include-tags article,main

# Exclude navigation and ads
firecrawl https://example.com --exclude-tags nav,aside,.ad
```

---

### `search` - Search the web

Search the web and optionally scrape content from search results.

```bash
# Basic search
firecrawl search "firecrawl web scraping"

# Limit results
firecrawl search "AI news" --limit 10

# Search news sources
firecrawl search "tech startups" --sources news

# Search images
firecrawl search "landscape photography" --sources images

# Multiple sources
firecrawl search "machine learning" --sources web,news,images

# Filter by category (GitHub, research papers, PDFs)
firecrawl search "web scraping python" --categories github
firecrawl search "transformer architecture" --categories research
firecrawl search "machine learning" --categories github,research

# Time-based search
firecrawl search "AI announcements" --tbs qdr:d   # Past day
firecrawl search "tech news" --tbs qdr:w          # Past week

# Location-based search
firecrawl search "restaurants" --location "San Francisco,California,United States"
firecrawl search "local news" --country DE

# Search and scrape results
firecrawl search "firecrawl tutorials" --scrape
firecrawl search "API documentation" --scrape --scrape-formats markdown,links

# Output as pretty JSON
firecrawl search "web scraping"
```

#### Search Options

| Option                       | Description                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `--limit <n>`                | Maximum results (default: 5, max: 100)                                                      |
| `--sources <sources>`        | Comma-separated: `web`, `images`, `news` (default: web)                                     |
| `--categories <categories>`  | Comma-separated: `github`, `research`, `pdf`                                                |
| `--tbs <value>`              | Time filter: `qdr:h` (hour), `qdr:d` (day), `qdr:w` (week), `qdr:m` (month), `qdr:y` (year) |
| `--location <location>`      | Geo-targeting (e.g., "Germany", "San Francisco,California,United States")                   |
| `--country <code>`           | ISO country code (default: US)                                                              |
| `--timeout <ms>`             | Timeout in milliseconds (default: 60000)                                                    |
| `--ignore-invalid-urls`      | Exclude URLs invalid for other Firecrawl endpoints                                          |
| `--scrape`                   | Enable scraping of search results                                                           |
| `--scrape-formats <formats>` | Scrape formats when `--scrape` enabled (default: markdown)                                  |
| `--only-main-content`        | Include only main content when scraping (default: true)                                     |
| `-o, --output <path>`        | Save to file                                                                                |
| `--json`                     | Output as compact JSON (use `-p` for pretty JSON)                                           |

#### Examples

```bash
# Research a topic with recent results
firecrawl search "React Server Components" --tbs qdr:m --limit 10

# Find GitHub repositories
firecrawl search "web scraping library" --categories github --limit 20

# Search and get full content
firecrawl search "firecrawl documentation" --scrape --scrape-formats markdown -p -o results.json

# Find research papers
firecrawl search "large language models" --categories research -p

# Search with location targeting
firecrawl search "best coffee shops" --location "Berlin,Germany" --country DE

# Get news from the past week
firecrawl search "AI startups funding" --sources news --tbs qdr:w --limit 15
```

---

### `map` - Discover all URLs on a website

Quickly discover all URLs on a website without scraping content.

```bash
# List all URLs (one per line)
firecrawl map https://example.com

# Output as JSON
firecrawl map https://example.com --json

# Search for specific URLs
firecrawl map https://example.com --search "blog"

# Limit results
firecrawl map https://example.com --limit 500
```

#### Map Options

| Option                      | Description                       |
| --------------------------- | --------------------------------- |
| `--limit <n>`               | Maximum URLs to discover          |
| `--search <query>`          | Filter URLs by search query       |
| `--sitemap <mode>`          | `include`, `skip`, or `only`      |
| `--include-subdomains`      | Include subdomains                |
| `--ignore-query-parameters` | Dedupe URLs with different params |
| `--timeout <seconds>`       | Request timeout                   |
| `--json`                    | Output as JSON                    |
| `-o, --output <path>`       | Save to file                      |

#### Examples

```bash
# Find all product pages
firecrawl map https://shop.example.com --search "product"

# Get sitemap URLs only
firecrawl map https://example.com --sitemap only

# Save URL list to file
firecrawl map https://example.com -o urls.txt

# Include subdomains
firecrawl map https://example.com --include-subdomains --limit 1000
```

---

### `crawl` - Crawl an entire website

Crawl multiple pages from a website.

```bash
# Start a crawl (returns job ID)
firecrawl crawl https://example.com

# Wait for crawl to complete
firecrawl crawl https://example.com --wait

# With progress indicator
firecrawl crawl https://example.com --wait --progress

# Check crawl status
firecrawl crawl <job-id>

# Limit pages
firecrawl crawl https://example.com --limit 100 --max-depth 3
```

#### Crawl Options

| Option                      | Description                              |
| --------------------------- | ---------------------------------------- |
| `--wait`                    | Wait for crawl to complete               |
| `--progress`                | Show progress while waiting              |
| `--limit <n>`               | Maximum pages to crawl                   |
| `--max-depth <n>`           | Maximum crawl depth                      |
| `--include-paths <paths>`   | Only crawl matching paths                |
| `--exclude-paths <paths>`   | Skip matching paths                      |
| `--sitemap <mode>`          | `include`, `skip`, or `only`             |
| `--allow-subdomains`        | Include subdomains                       |
| `--allow-external-links`    | Follow external links                    |
| `--crawl-entire-domain`     | Crawl entire domain                      |
| `--ignore-query-parameters` | Treat URLs with different params as same |
| `--delay <ms>`              | Delay between requests                   |
| `--max-concurrency <n>`     | Max concurrent requests                  |
| `--timeout <seconds>`       | Timeout when waiting                     |
| `--poll-interval <seconds>` | Status check interval                    |

#### Examples

```bash
# Crawl blog section only
firecrawl crawl https://example.com --include-paths /blog,/posts

# Exclude admin pages
firecrawl crawl https://example.com --exclude-paths /admin,/login

# Crawl with rate limiting
firecrawl crawl https://example.com --delay 1000 --max-concurrency 2

# Deep crawl with high limit
firecrawl crawl https://example.com --limit 1000 --max-depth 10 --wait --progress

# Save results
firecrawl crawl https://example.com --wait -o crawl-results.json --pretty
```

---

### `credit-usage` - Check your credits

```bash
# Show credit usage
firecrawl credit-usage

# Output as JSON
firecrawl credit-usage --json --pretty
```

---

### `config` - Configure and view settings

```bash
# View current configuration
firecrawl config

# Configure with custom API URL
firecrawl config --api-url https://firecrawl.mycompany.com
firecrawl config --api-url http://localhost:3002 --api-key fc-xxx
```

Shows authentication status and stored credentials location.

---

### `login` / `logout`

```bash
# Login
firecrawl login
firecrawl login --method browser
firecrawl login --method manual
firecrawl login --api-key fc-xxx

# Login to self-hosted instance
firecrawl login --api-url https://firecrawl.mycompany.com
firecrawl login --api-url http://localhost:3002 --api-key fc-xxx

# Logout
firecrawl logout
```

---

## Global Options

These options work with any command:

| Option                | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `--status`            | Show version, auth, concurrency, and credits           |
| `-k, --api-key <key>` | Use specific API key                                   |
| `--api-url <url>`     | Use custom API URL (for self-hosted/local development) |
| `-V, --version`       | Show version                                           |
| `-h, --help`          | Show help                                              |

### Check Status

```bash
firecrawl --status
```

```
  🔥 firecrawl cli v1.0.2

  ● Authenticated via stored credentials
  Concurrency: 0/100 jobs (parallel scrape limit)
  Credits: 500,000 / 1,000,000 (50% left this cycle)
```

---

## Output Handling

### Stdout vs File

```bash
# Output to stdout (default)
firecrawl https://example.com

# Pipe to another command
firecrawl https://example.com | head -50

# Save to file
firecrawl https://example.com -o output.md

# JSON output
firecrawl https://example.com --format links --pretty
```

### Format Behavior

- **Single format**: Outputs raw content (markdown text, HTML, etc.)
- **Multiple formats**: Outputs JSON with all requested data

```bash
# Raw markdown output
firecrawl https://example.com --format markdown

# JSON output with multiple formats
firecrawl https://example.com --format markdown,links,images
```

---

## Tips & Tricks

### Scrape multiple URLs

```bash
# Using a loop
for url in https://example.com/page1 https://example.com/page2; do
  firecrawl "$url" -o "$(echo $url | sed 's/[^a-zA-Z0-9]/_/g').md"
done

# From a file
cat urls.txt | xargs -I {} firecrawl {} -o {}.md
```

### Combine with other tools

```bash
# Extract links and process with jq
firecrawl https://example.com --format links | jq '.links[].url'

# Convert to PDF (with pandoc)
firecrawl https://example.com | pandoc -o document.pdf

# Search within scraped content
firecrawl https://example.com | grep -i "keyword"
```

### CI/CD Usage

```bash
# Set API key via environment
export FIRECRAWL_API_KEY=${{ secrets.FIRECRAWL_API_KEY }}
firecrawl crawl https://docs.example.com --wait -o docs.json

# Use self-hosted instance
export FIRECRAWL_API_URL=${{ secrets.FIRECRAWL_API_URL }}
firecrawl scrape https://example.com -o output.md
```

---

## Telemetry

The CLI collects anonymous usage data during authentication to help improve the product:

- CLI version, OS, and Node.js version
- Detect development tools (e.g., Cursor, VS Code, Claude Code)

**No command data, URLs, or file contents are collected via the CLI.**

To disable telemetry, set the environment variable:

```bash
export FIRECRAWL_NO_TELEMETRY=1
```

---

## Documentation

For more details, visit the [Firecrawl Documentation](https://docs.firecrawl.dev).
