# Changelog

## 1.27.0

- `find-tools` retries once on HTTP 503 `query_embed_unavailable`. The wait follows `Retry-After` and is capped at 3 seconds. The same request id is reused. A second failure is retryable.
- Alexandria skills are four operations: `skills list`, `skills read`, `skills create`, and `skills update`. `find-skills`, `read-skill`, `create-skill`, and `update-skill` are the same commands.
- `skills list --provider <provider>` asks Exchange for that provider's skills (`provider`, `q`, and `page`). It reads `provider.slug` and `plugin.id`.
- `skills list` takes a natural-language goal. Official and provider skills are ranked semantically; team skills still match every word.
- `search` prints a Skills section after web results and tools when `data.skills` is present, and includes those cards in `--json`. The hint is `firecrawl skills read <id>`. A response without `data.skills` is unchanged.
- `skills read --provider <provider> --plugin <plugin> --skill <skill>` reads a provider skill. `--file` reads its file.
- `skills create` sends `from`, `name`, `description`, `body`, and `slug`. `skills update` sends `id`, `baseVersion`, `name`, `description`, `body`, `enabled`, and `discoverable`. A successful create or update prints `https://www.firecrawl.dev/app/alexandria/skills/<slug>` (the slug without `team:`) and includes it as `url` in `--json`.
- Merged execution prices for Carbon Arc (1000 credits a call), Influencers.club, and People Data Labs. Misses on People Data Labs are free. `list` and `find-tools` fill a missing discovery price from that catalog when `--include-costs` is set. `search` always omits tool prices.
- People Data Labs async enrichment is execution-only and has no CLI flag.
