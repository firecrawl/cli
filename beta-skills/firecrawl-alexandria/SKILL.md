---
name: firecrawl-alexandria
description: Use with Firecrawl beta search when natural web results include Alexandria tools, when the user explicitly wants tools for a task or website, or when executing a discovered provider tool. Search normally, inspect matching contracts, and execute through Scrape. Find Tools is the catalogue meta tool. Requires an authorized Firecrawl API key.
---

# Alexandria Beta

Use the beta CLI explicitly on every invocation: `npx firecrawl-cli@alexandria`. Version `1.23.4-alexandria-beta.1` or newer needs no enable flag. Do not replace the user's stable CLI or use a direct Exchange connection.

Use `FIRECRAWL_API_KEY` or existing Firecrawl login credentials. Never print credentials. Installing the beta is not authorization: the API enforces team and provider access.

## Natural search first

Start with the user's actual question, including the location, marketplace, and constraints. Do not rewrite an ordinary research question into a request for APIs or tools. Default search returns web results and relevant Alexandria tools together, with domain matching enabled:

```sh
npx firecrawl-cli@alexandria search "homes for sale in Lower Haight San Francisco" --domain-tools --json -o .firecrawl/homes.json
```

Read both `data.web` and `data.tools`. Tools are discovery results, not fetched provider data. Use useful web results directly; when a returned tool fits, inspect its contract and execute it through `scrape --alexandria`. Search never automatically executes provider tools, including with `--scrape` (which fetches web page content).

A complete contract returned by search needs no additional discovery call. Check country/marketplace, rental versus sale, individual-record versus aggregate coverage, required inputs, `creditsCost`, `perRecord`, and access requirements. Use returned lookup tools to resolve record IDs; never invent them. A related domain or topic does not establish coverage. If no candidate fits, use web results or ordinary URL scrape instead of walking the entire catalogue.

`--sources web` opts out of Alexandria. `--sources web --domain-tools` includes tools for web-result domains. `--no-domain-tools` disables domain matching but does not remove semantic Alexandria results when that source is selected. Keep the normal default unless the user requests a narrower source.

## Follow the search results

1. Run the user's question as an ordinary search with `--domain-tools --json`. Keep their location, dates, filters, and requested outcome in the query.
2. Read `data.web` for web results and `data.tools` for discovered tools. Semantic matches come from the Alexandria source; domain matches come from websites in the web results. Neither executes a provider call.
3. Use web results when they answer the question. For structured or deeper data, select a tool whose description and contract cover the request. If search already includes the full contract, use it without another discovery call.
4. If the contract is missing, fetch only that returned provider/capability with `find-tools`. If the user named a website missing from the results, use `find-tools <url>` to inspect it directly.
5. Execute the selected contract through `scrape --alexandria <provider>/<capability> --options '<contract-shaped JSON>' --json`. Use exact discovered IDs and input fields. Read the per-call result, not just the outer success flag.
6. Answer with the returned data and source links. If no tool fits, continue with web results or ordinary URL scraping.

For example, start with a normal question:

```sh
npx firecrawl-cli@alexandria search "What are the latest analyst ratings for Apple AAPL?" --domain-tools --json
```

Inspect the returned tools before choosing a provider. Pass `AAPL` using the selected contract's actual ticker field; do not assume all providers accept the same options. Search discovers candidate tools; Scrape executes one after selection.

| Search flags                   | Web results | Semantic tools | Tools for result domains |
| ------------------------------ | ----------- | -------------- | ------------------------ |
| Default or `--domain-tools`    | Yes         | Yes            | Yes                      |
| `--sources web --domain-tools` | Yes         | No             | Yes                      |
| `--sources alexandria`         | No          | Yes            | No web results to match  |
| `--no-domain-tools`            | Yes         | Yes            | No                       |
| `--sources web`                | Yes         | No             | No                       |

## Browse the catalog progressively

Workflow providers and capabilities come from the live published catalogue. Use the exact IDs returned by discovery; do not infer a provider ID from its display name or domain. In the examples below, set `RETURNED_PROVIDER` and `RETURNED_CAPABILITY` from the matching result you selected.

With beta `1.23.4-alexandria-beta.9` or newer, use `list` when the user wants to browse categories, providers, or a known provider's tools:

```sh
npx firecrawl-cli@alexandria alexandria list
npx firecrawl-cli@alexandria list finance
npx firecrawl-cli@alexandria list "$RETURNED_PROVIDER" --json
npx firecrawl-cli@alexandria list "$RETURNED_PROVIDER" "$RETURNED_CAPABILITY" --json
```

The root shows an introduction, discovery/execution commands, and live categories with descriptions. A category lists its providers; a provider lists compact tools directly. Selecting a complete capability ID, such as `calendar/ratings`, expands only that contract, including price, inputs, response, and examples. Categories are optional: use returned provider and capability IDs directly. Use `list --providers` only when a flat provider inventory is needed. `list-tools` is an alias for `list`; both also work under `alexandria`. `--category` resolves ambiguous category/provider IDs explicitly. Category display names such as `retail`, `developer`, and `public-records` are accepted alongside the returned canonical IDs.

The root reads the free public `GET /exchange/discover` route on the configured Firecrawl API with existing credentials. Category rows are at `data.items` in JSON. Provider and tool lookups use the free Find Tools meta tool through Scrape, with rows at `data.alexandria[0].data.items`. Both include `discoveryRequests` and `nextCommand` navigation; no listed tool is executed. The root shows all categories. Provider/tool page size defaults to 20 (`--limit 1–100`); follow `More`/`nextCommand` only when needed. Generated commands start with `firecrawl`; replace that prefix with `npx firecrawl-cli@alexandria` to stay on this beta. Raw `--request` next requests preserve selectors and pagination and must not be mixed with a path or filters.

## Explicit requests for tools: search then the Find Tools meta tool

For “find tools that can look up company filings,” search only tool capabilities:

```sh
npx firecrawl-cli@alexandria search "tools to search company filings" --sources alexandria --json
```

Then use `find-tools` when the user wants a set of tools for a returned provider, a known website, or a specific contract. It is a meta tool: it lists tools and their inputs, without executing them. The CLI sends `firecrawl/find-tools` through the same Scrape API used for every provider execution. Do not call Exchange endpoints directly.

Set `DOMAIN` to the user's website URL. For further browsing or inspection, set `RETURNED_NEXT_JSON` to the selected item's complete `next` request.

```sh
# Known website: discover its providers, without fetching the URL
npx firecrawl-cli@alexandria find-tools "$DOMAIN" --json

# Or describe the needed capability
npx firecrawl-cli@alexandria find-tools --options '{"query":"USAspending agency obligations"}' --json

# Follow the selected result to its tools or contract
npx firecrawl-cli@alexandria find-tools --request "$RETURNED_NEXT_JSON" --json
```

`find-tools` accepts free-text `query` through `--options`, URLs, and catalogue selectors: `urls`, `providers`, `categories`, `groups`, `capabilities`. Discovery is free. Valid `level` values: `providers`, `groups`, `tools` (not `capabilities`). `limit` accepts 1–100 and defaults to 5; use 100 for an explicitly requested broad tool list. Follow pagination only if more results are needed. Add `examples` to `expand` only when inputs remain unclear.

Items are at `data.alexandria[i].data.items`; each call has its own envelope. An item's `next` browses or expands that result; the page's `data.alexandria[i].data.next` continues pagination. Pass either request unchanged through `--request`; do not combine it with URL/filter arguments. If a result already has the full contract, proceed with that contract without another discovery call.

An empty URL lookup means no visible provider matched that domain. A semantic match can still target a different country or unsupported segment. Never make an unrelated paid probe to test coverage.

## Execute through Scrape

After inspecting a fitting contract and its price, use its returned provider and capability IDs. Set `INPUT_JSON` to options constructed from that contract's inputs and the user's task:

```sh
npx firecrawl-cli@alexandria scrape --alexandria "$RETURNED_PROVIDER/$RETURNED_CAPABILITY" --options "$INPUT_JSON" --json
```

For an existing URL, ordinary scrape can optionally return related tools alongside the page:

```sh
npx firecrawl-cli@alexandria scrape "$DOMAIN" --domain-tools --json
```

This discovers tools without executing them. On access refusal, report it rather than repeatedly retrying or bypassing the gate.

## Read receipts and failures

- Search: `creditsUsed` and `id` at the top level.
- URL scrape: `metadata.creditsUsed` in its JSON output.
- Meta-tool/provider calls: `data.creditsCost` plus `data.alexandria[i].creditsCost`; inspect each call's `error` too.
- Tool prices are `creditsCost` and `perRecord`, not a `pricing` field. Do not assume every tool has the same price.
- Save JSON and stderr separately. `2>&1` mixes Request ID lines into JSON and breaks parsing.
- Team balance deltas include concurrent users and tests. Attribute spend from receipts, and reconcile the full time window before alleging overbilling.
- Empty provider results may still be billed. A successful HTTP envelope is not proof the task returned usable records.
