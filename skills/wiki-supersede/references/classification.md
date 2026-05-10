# Mention Classification Reference

Each mention found by `commonplace supersede --scan` is sorted into one of six buckets. Use this table to interpret scan output and decide what to do per hit.

| Bucket | Meaning | Action |
|---|---|---|
| `historical` | Already past-tense ("we used X back when…") | Leave alone |
| `comparison` | Discusses X vs Y, alternatives, tradeoffs | Leave alone |
| `already-retired` | Mention is inside the old note itself or another already-retired note | Leave alone |
| `live` | Bare-prose mention treating X as currently in use | **Rewrite candidate** |
| `live-in-code` | Inside a fenced code block. If the fence has a language hint and the token is an identifier (matches `/^[\w@.\-]+$/`), it's safe to rename; otherwise mark `needs-review` because rewriting could break example code | Rewrite if rename-only safe; else escalate |
| `needs-review` | Heuristics inconclusive — show paragraph context to the user | Ask user |

The script prints counts per bucket plus the file/paragraph context for everything that isn't `historical`/`already-retired`.

## Rewrite guidance for `live` hits

For each `live` hit (and rename-safe `live-in-code`), rewrite the surrounding sentence into past tense or comparison framing. Use main-model judgment; do not attempt mechanical regex rewrites of prose. Keep the original wikilink target — it will resolve through the rename via the link rewrite that `--retire` performs.

## Sampling before mass edits

Always show the user 3–5 representative classifications (mix of buckets) before any rewrite. Classification is heuristic; the user should sanity-check before mass edits.
