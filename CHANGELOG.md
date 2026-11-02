# Changelog

## 1.27.0

- `find-tools` retries once on HTTP 503 `query_embed_unavailable`. The wait follows `Retry-After` and is capped at 3 seconds. The same request id is reused. A second failure is retryable.
- Alexandria skills are four operations: `skills list`, `skills read`, `skills create`, and `skills update`. `find-skills`, `read-skill`, `create-skill`, and `update-skill` are the same commands.
- `skills list --provider <provider>` lists that provider's published skills and omits execution-only skills.
- `skills read --provider <provider> --plugin <plugin> --skill <skill>` reads a provider skill. `--file` reads its file.
- `skills create` and `skills update` are unchanged, including `--shared true|false`.
- Merged execution prices for Carbon Arc (1000 credits a call), Influencers.club, and People Data Labs. Misses on People Data Labs are free. `list` and `find-tools` fill a missing discovery price from that catalog when `--include-costs` is set. `search` always omits tool prices.
- People Data Labs async enrichment is execution-only and has no CLI flag.
