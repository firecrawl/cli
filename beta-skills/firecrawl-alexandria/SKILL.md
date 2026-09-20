---
name: firecrawl-alexandria
description: Find an efficient path to structured data with Firecrawl's ready-made website workflows, API providers, and specialized indexes. Use for records, listings, financial data, research, or public records when tools can retrieve deeper data beyond a web page. Discover with search, inspect selected contracts, and execute through scrape.
---

# Alexandria: a direct path to structured data

Use `npx firecrawl-cli@alexandria` for these commands. Use the user's existing Firecrawl credentials; the API enforces team and provider access. Do not replace their stable CLI installation.

Alexandria brings website workflows, API providers, and specialized indexes into search and scrape. Discover current coverage instead of assuming a provider exists. Use ordinary web results when sufficient, and select a tool when its coverage and inputs provide a more direct route to the requested data.

## Search naturally

Preserve the user's question, location, market, dates, and constraints. Default search combines web results with semantic and domain-matched tools:

```bash
npx firecrawl-cli@alexandria search '<user question>' --json
npx firecrawl-cli@alexandria search alexandria '<data you need>' --json
```

- **Semantic discovery** finds capabilities by the meaning of the question, even without a provider website in the web results. `search alexandria` requests only semantic tools.
- **Domain matching** connects result websites to tools that may retrieve richer details, related records, or structured collections beyond the linked page. A matching domain alone does not prove coverage.
- **Combined search** returns `data.web` and `data.tools` together. A tool match is a discovery result, not executed provider data. `search --scrape` fetches web page content, not provider tools.

`--sources web` requests web only. `--sources web --domain-tools` adds domain matches without semantic tools. `--no-domain-tools` disables domain matching while preserving the selected sources.

## Inspect only what you need

Tool summaries identify candidates without loading every input/output contract. A compact result may contain only `provider`, `capability` and `description`; use the `provider` and `capability` IDs to inspect it without an `id` or `next` field. If a result already includes its complete contract, reuse it. Otherwise inspect the selected provider and capability before execution:

```bash
npx firecrawl-cli@alexandria list <provider-id> <capability-id> --pretty
```

Check required inputs, supported location/market, returned fields, and access requirements. Use lookup tools to resolve record IDs rather than inventing them. Displayed pricing is informational, not an additional confirmation gate. If no tool fits, continue with web results or URL scrape rather than exhausting the catalogue.

Read the expanded contract before building inputs or parsing results:

- `required: true` requires that input; each `requiresOneOf` group requires at least one member, not all of them.
- Selected-contract inspection already requests examples. Read the singular `example.request` and `example.response` when present; an empty request can be valid for tools with optional inputs.
- `response.key` identifies the records field inside `data.alexandria[i].data`; an empty key means that data object itself. Do not assume every provider returns `records`.
- Provider pagination differs from catalogue `next`: use the contract's continuation input and the returned page/cursor, preserve filters, and stop at its exhaustion signal. `paginated: true` alone does not specify that mapping.

For progressive browsing:

```bash
npx firecrawl-cli@alexandria list
npx firecrawl-cli@alexandria list <category-id> --category
npx firecrawl-cli@alexandria list <provider-id>
npx firecrawl-cli@alexandria list <provider-id> <capability-id> --pretty
```

Use returned IDs, not display names or guessed domains. Follow `nextCommand` only when more results are needed; replace its `firecrawl` prefix with `npx firecrawl-cli@alexandria`.

Find Tools is the catalogue meta tool. It can match a known website, search semantically, or expand a selected contract:

```bash
npx firecrawl-cli@alexandria find-tools '<website-url>' --json
npx firecrawl-cli@alexandria find-tools --options '{"query":"<data you need>"}' --json
npx firecrawl-cli@alexandria find-tools --request '<returned next request as JSON>' --json
```

An item's `next` request expands that item; the page's `next` paginates with scope preserved. Pass the complete request unchanged through `--request`, without URL/filter arguments. Find Tools results are under `data.alexandria[i].data`; inspect its `items` and `next`. Catalogue discovery never executes the listed provider tools.

## Execute through scrape

```bash
npx firecrawl-cli@alexandria scrape <provider-id>/<capability-id> --options '<JSON matching the selected contract>' --json
npx firecrawl-cli@alexandria scrape '<website-url>' --domain-tools --json
```

The first command executes the selected tool; `--alexandria <provider-id>/<capability-id>` remains supported. The second reads the page and discovers related tools without executing them.

Check each `data.alexandria[]` entry for errors, not just the outer success flag. Empty results do not establish complete coverage. Keep source links and disclose partial results. On a terms refusal, review the terms and obtain explicit user authorization before accepting; use `terms --help`. Do not bypass access refusals or repeatedly retry them.

Use help to discover exact options rather than guessing:

```bash
npx firecrawl-cli@alexandria search --help
npx firecrawl-cli@alexandria list --help
npx firecrawl-cli@alexandria find-tools --help
npx firecrawl-cli@alexandria scrape --help
```

## Large results and context recovery

Save large JSON responses with `--json -o <path>` when a local filesystem is available, then select the needed fields and rows with `jq`. Keep stderr separate; receipt lines are not JSON. Do not use `2>&1` when piping JSON to a parser.

If the agent's output/context limit hides a response, the upstream request may already have succeeded. Preserve the returned request or scrape ID before considering another execution. Remote `firecrawl/bash` can inspect eligible retained results, sample records, filter fields, and read sections without returning the whole payload to context. Read [large-result recovery](references/large-results.md) when you need that path. Search IDs are not valid Bash sources, and not every result is retained.
