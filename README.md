# 🔥 Firecrawl CLI

Command-line interface for Firecrawl. Search, scrape, interact, crawl, map, and run agent jobs directly from your terminal.

## Installation

```bash
npm install -g firecrawl-cli
```

Or set up everything in one command (install CLI globally, authenticate, and add skills across all detected coding editors):

```bash
npx -y firecrawl-cli@1.16.2 init -y --browser
```

- `-y` runs setup non-interactively
- `--browser` opens the browser for Firecrawl authentication automatically
- skills install globally to every detected AI coding agent by default

### Setup Skills, Workflows, and MCP

If you are using an AI coding agent like Claude Code, you can also install the skills manually:

```bash
firecrawl setup skills
firecrawl setup workflows
```

These install globally across all detected coding editors by default. Use `--agent <agent>` to scope either command to one editor.

### Agent skills

The init command installs all Firecrawl agent skill segments into AI coding agents (Cursor, Claude Code, Windsurf, etc.):

- **CLI skills** — teach agents how to use the Firecrawl CLI for live web work (search, scrape, interact, map, crawl, agent)
- **Build skills** — teach agents how to integrate Firecrawl into application code (choose endpoints, wire SDKs, set up API keys)
- **Workflow skills** — teach agents how to produce Firecrawl-powered deliverables such as research briefs, SEO audits, QA reports, lead lists, knowledge bases, and design-system extraction

To reinstall skills manually:

```bash
firecrawl setup skills
firecrawl setup workflows
```

To install the Firecrawl MCP server into your editors (Cursor, Claude Code, VS Code, etc.):

```bash
firecrawl setup mcp
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
  Search, scrape, and interact with the web

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

### `scrape` - Scrape URLs

Extract content from any webpage. Pass multiple URLs to scrape them concurrently -- each result is saved to `.firecrawl/` automatically.

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

# Multiple URLs (scraped concurrently, each saved to .firecrawl/)
firecrawl scrape https://firecrawl.dev https://firecrawl.dev/blog https://docs.firecrawl.dev
```

#### Scrape Options

| Option                     | Description                                             |
| -------------------------- | ------------------------------------------------------- |
| `-f, --format <formats>`   | Output format(s), comma-separated                       |
| `-H, --html`               | Shortcut for `--format html`                            |
| `-S, --summary`            | Shortcut for `--format summary`                         |
| `--only-main-content`      | Extract only main content (removes navs, footers, etc.) |
| `--wait-for <ms>`          | Wait time before scraping (for JS-rendered content)     |
| `--screenshot`             | Take a screenshot                                       |
| `--full-page-screenshot`   | Take a full page screenshot                             |
| `--include-tags <tags>`    | Only include specific HTML tags                         |
| `--exclude-tags <tags>`    | Exclude specific HTML tags                              |
| `--max-age <milliseconds>` | Maximum age of cached content in milliseconds           |
| `--lockdown`               | Enable lockdown mode for the scrape                     |
| `--redact-pii`             | Redact personally identifiable information from output  |
| `--schema <json>`          | JSON schema for structured extraction                   |
| `--schema-file <path>`     | Path to JSON schema file for structured extraction      |
| `--actions <json>`         | JSON actions array to run during scrape                 |
| `--actions-file <path>`    | Path to JSON actions file                               |
| `--proxy <proxy>`          | Proxy mode for scraping (for example, `auto`, `basic`)  |
| `-o, --output <path>`      | Save output to file                                     |
| `--json`                   | Output as JSON format                                   |
| `--pretty`                 | Pretty print JSON output                                |
| `--timing`                 | Show request timing info                                |

#### Available Formats

| Format           | Description                  |
| ---------------- | ---------------------------- |
| `markdown`       | Clean markdown (default)     |
| `html`           | Cleaned HTML                 |
| `rawHtml`        | Original HTML                |
| `links`          | All links on the page        |
| `images`         | All images on the page       |
| `screenshot`     | Screenshot as base64         |
| `summary`        | AI-generated summary         |
| `json`           | Structured JSON extraction   |
| `changeTracking` | Track changes on the page    |
| `attributes`     | Page attributes and metadata |
| `branding`       | Brand identity extraction    |

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
firecrawl search "firecrawl"

# Limit results
firecrawl search "AI news" --limit 10

# Search news sources
firecrawl search "tech startups" --sources news

# Search images
firecrawl search "landscape photography" --sources images

# Multiple sources
firecrawl search "machine learning" --sources web,news,images

# Filter by category (GitHub, research papers, PDFs)
firecrawl search "web data python" --categories github
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
firecrawl search "AI data tools"
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
| `--json`                     | Output as compact JSON                                                                      |

#### Examples

```bash
# Research a topic with recent results
firecrawl search "React Server Components" --tbs qdr:m --limit 10

# Find GitHub repositories
firecrawl search "web data library" --categories github --limit 20

# Search and get full content
firecrawl search "firecrawl documentation" --scrape --scrape-formats markdown --json -o results.json

# Find research papers
firecrawl search "large language models" --categories research --json

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

| Option                         | Description                              |
| ------------------------------ | ---------------------------------------- |
| `--wait`                       | Wait for crawl to complete               |
| `--progress`                   | Show progress while waiting              |
| `--limit <n>`                  | Maximum pages to crawl                   |
| `--max-depth <n>`              | Maximum crawl depth                      |
| `--include-paths <paths>`      | Only crawl matching paths                |
| `--exclude-paths <paths>`      | Skip matching paths                      |
| `--sitemap <mode>`             | `include`, `skip`, or `only`             |
| `--allow-subdomains`           | Include subdomains                       |
| `--allow-external-links`       | Follow external links                    |
| `--crawl-entire-domain`        | Crawl entire domain                      |
| `--ignore-query-parameters`    | Treat URLs with different params as same |
| `--delay <ms>`                 | Delay between requests                   |
| `--max-concurrency <n>`        | Max concurrent requests                  |
| `--scrape-options <json>`      | JSON scrape options passed to each page  |
| `--scrape-options-file <path>` | Path to scrape options JSON file         |
| `--webhook <url-or-json>`      | Webhook URL or configuration             |
| `--cancel`                     | Cancel an active crawl job by job ID     |
| `--timeout <seconds>`          | Timeout when waiting                     |
| `--poll-interval <seconds>`    | Status check interval                    |

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

### `agent` - AI-powered web data extraction

Run an AI agent that autonomously browses and extracts structured data from the web based on natural language prompts.

> **Note:** Agent tasks typically take **2 to 5 minutes** to complete, and sometimes longer for complex extractions. Use sparingly and consider `--max-credits` to limit costs.

```bash
# Basic usage (returns job ID immediately)
firecrawl agent "Find the pricing plans for Firecrawl"

# Wait for completion
firecrawl agent "Extract all product names and prices from this store" --wait

# Focus on specific URLs
firecrawl agent "Get the main features listed" --urls https://example.com/features

# Use structured output with JSON schema
firecrawl agent "Extract company info" --schema '{"type":"object","properties":{"name":{"type":"string"},"employees":{"type":"number"}}}'

# Load schema from file
firecrawl agent "Extract product data" --schema-file ./product-schema.json --wait

# Check status of an existing job
firecrawl agent <job-id>
firecrawl agent <job-id> --wait
```

#### Agent Options

| Option                      | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `--urls <urls>`             | Comma-separated URLs to focus extraction on                   |
| `--model <model>`           | `spark-1-mini` (default, cheaper) or `spark-1-pro` (accurate) |
| `--schema <json>`           | JSON schema for structured output (inline JSON string)        |
| `--schema-file <path>`      | Path to JSON schema file for structured output                |
| `--max-credits <number>`    | Maximum credits to spend (job fails if exceeded)              |
| `--webhook <url-or-json>`   | Webhook URL or configuration                                  |
| `--status`                  | Check status of existing agent job                            |
| `--cancel`                  | Cancel an active agent job by job ID                          |
| `--wait`                    | Wait for agent to complete before returning results           |
| `--poll-interval <seconds>` | Polling interval in seconds when waiting (default: 5)         |
| `--timeout <seconds>`       | Timeout in seconds when waiting (default: no timeout)         |
| `-o, --output <path>`       | Save output to file                                           |
| `--json`                    | Output as JSON format                                         |
| `--pretty`                  | Pretty print JSON output                                      |

#### Examples

```bash
# Research task with timeout
firecrawl agent "Find the top 5 competitors of Notion and their pricing" --wait --timeout 300

# Extract data with cost limit
firecrawl agent "Get all blog post titles and dates" --urls https://blog.example.com --max-credits 100 --wait

# Use higher accuracy model for complex extraction
firecrawl agent "Extract detailed technical specifications" --model spark-1-pro --wait --pretty

# Save structured results to file
firecrawl agent "Extract contact information" --schema-file ./contact-schema.json --wait -o contacts.json --pretty

# Check job status without waiting
firecrawl agent abc123-def456-... --json

# Poll a running job until completion
firecrawl agent abc123-def456-... --wait --poll-interval 10
```

---

### `interact` - Interact with scraped pages

Scrape a page, then interact with it in a live browser session using natural language or code. No manual session management required.

```bash
# 1. Scrape a page first
firecrawl scrape https://example.com

# 2. Interact with it
firecrawl interact "Click the pricing tab"
firecrawl interact "Fill in the email field with test@example.com"
firecrawl interact "Extract the pricing table"

# 3. Code execution (Playwright)
firecrawl interact -c "await page.title()"
firecrawl interact -c "print(await page.title())" --python

# 4. Stop the session
firecrawl interact stop
```

#### Interact Options

| Option                 | Description                                    |
| ---------------------- | ---------------------------------------------- |
| `-p, --prompt <text>`  | AI prompt (alternative to positional argument) |
| `-c, --code <code>`    | Code to execute in the browser sandbox         |
| `-s, --scrape-id <id>` | Scrape job ID (default: last scrape)           |
| `--python`             | Execute code as Python/Playwright              |
| `--node`               | Execute code as Node.js/Playwright (default)   |
| `--bash`               | Execute code as Bash                           |
| `--timeout <seconds>`  | Timeout in seconds (1-300, default: 30)        |
| `-o, --output <path>`  | Save output to file                            |
| `--json`               | Output as JSON format                          |

#### Profiles

Use `--profile` on the scrape to persist browser state across scrapes:

```bash
# Login and save state
firecrawl scrape "https://app.example.com/login" --profile my-app
firecrawl interact "Fill in email and click login"

# Come back authenticated later
firecrawl scrape "https://app.example.com/dashboard" --profile my-app
firecrawl interact "Extract the dashboard data"
```

---

### `monitor` - Watch pages for changes

Create monitors when the goal is ongoing change detection, alerting, or repeated checks over time. A monitor runs recurring scrapes or crawls, diffs each result against the last retained snapshot, and can notify webhooks or email recipients.

```bash
firecrawl monitor create --name "Blog" \
  --goal "Notify me when a new post is published" \
  --schedule "every 30 minutes" \
  --page https://example.com/blog \
  --email alerts@example.com

firecrawl monitor create --name "Product pages" \
  --goal "Notify me when pricing, docs, or changelog content changes" \
  --schedule "every 30 minutes" \
  --scrape-urls https://example.com/pricing,https://example.com/docs,https://example.com/changelog

firecrawl monitor create --name "Docs webhook" \
  --goal "Notify me when docs content changes" \
  --schedule "every 30 minutes" \
  --page https://example.com/docs \
  --webhook-url https://example.com/webhook \
  --webhook-events monitor.page,monitor.check.completed

firecrawl monitor list --limit 20
firecrawl monitor run <monitorId>
firecrawl monitor checks <monitorId>
firecrawl monitor check <monitorId> <checkId> --page-status changed
firecrawl monitor update <monitorId> --state paused
firecrawl monitor delete <monitorId>
```

#### Monitor Options

| Option                    | Description                                         |
| ------------------------- | --------------------------------------------------- |
| `--name <name>`           | Monitor name                                        |
| `--goal <goal>`           | What changes this monitor should look for           |
| `--cron <expression>`     | Cron schedule (e.g. `*/30 * * * *`)                 |
| `--schedule <text>`       | Natural-language schedule (e.g. `every 30 minutes`) |
| `--timezone <tz>`         | Schedule timezone (default: `UTC`)                  |
| `--page <url>`            | Single page URL to scrape on each check             |
| `--scrape-urls <list>`    | Comma-separated page URLs to scrape on each check   |
| `--crawl-url <url>`       | Root URL for a crawl target                         |
| `--webhook-url <url>`     | Webhook destination                                 |
| `--webhook-events <list>` | Comma-separated webhook events                      |
| `--email <list>`          | Comma-separated email recipients                    |
| `--retention-days <n>`    | Snapshot retention window                           |

For advanced targets such as JSON-mode `changeTracking`, pass a JSON payload:

```bash
firecrawl monitor create monitor.json
cat monitor.json | firecrawl monitor create
```

---

### `config` - Configure settings

```bash
# Configure with custom API URL
firecrawl config --api-url https://firecrawl.mycompany.com
firecrawl config --api-url http://localhost:3002 --api-key fc-xxx
```

### `view-config` - View current configuration

```bash
# View current configuration and authentication status
firecrawl view-config
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
  🔥 firecrawl cli v1.16.2

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
# Just pass multiple URLs -- results are saved to .firecrawl/
firecrawl scrape https://firecrawl.dev https://firecrawl.dev/blog https://docs.firecrawl.dev
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

## Experimental

Experimental commands live under `firecrawl experimental` (alias: `firecrawl x`).

### `download` - Bulk Site Download

Combines `map` + `scrape` to save a site as local files under `.firecrawl/`.

```bash
firecrawl x download https://docs.firecrawl.dev
firecrawl x download https://docs.firecrawl.dev --screenshot --limit 20 -y
firecrawl x download https://docs.firecrawl.dev --include-paths "/features,/sdks" -y
```

### Workflow Skills

The old experimental AI workflow commands have moved to the NPX-installable
[`firecrawl/firecrawl-workflows`](https://github.com/firecrawl/firecrawl-workflows)
skills package. Workflow skills infer from the user's request first and only ask
short clarifying questions when required inputs are missing. Install them with:

```bash
firecrawl setup workflows
```

---

## Documentation

For more details, visit the [Firecrawl Documentation](https://docs.firecrawl.dev).
