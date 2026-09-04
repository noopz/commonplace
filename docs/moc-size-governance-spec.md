# Spec Outline — MOC Size Governance (no monolithic MOCs)

Status: draft outline · Owner: TBD · Related: `scripts/lint.ts`, `skills/wiki-ingest`, `agents/wiki-moc-updater.md`, `skills/autoimprove`

## 1. Problem

MOCs only ever grow. `wiki-moc-updater` adds sources and bumps the `## Papers (N)` count; nothing ever caps, warns, or splits. Result: one MOC can absorb a large fraction of the whole vault (observed: a single MOC holding ~45% of all sources). At that size a MOC stops discriminating — as a retrieval cue it points at half the corpus, so "member of MOC X" carries almost no signal, and an agent traversing it faces a huge, low-information neighbor set. The fix is to treat MOC size as a proxy for lost thematic coherence, and to prevent / detect / remediate bloat across the three surfaces that touch MOCs: **ingest, health/lint, and autoimprove.**

## 2. Goals / Non-goals

**Goals**
- No new MOC grows unbounded; bloat is caught mechanically and surfaced.
- Ingest prefers a narrower sub-MOC over piling onto an oversized one.
- Oversized MOCs get split into coherent sub-themes, not arbitrary shards.

**Non-goals**
- Not enforcing a hard membership limit that blocks legitimate large themes — size is a *trigger to review coherence*, not a ceiling.
- Not auto-splitting without a coherence judgment (splitting is semantic, not mechanical).
- No change to wikilink-resolution rules (filename-stem contract stays as-is).

## 3. Config additions — `.wiki/config.json`

New `moc` block (all tunable; proposed defaults):

```
"moc": {
  "softCap": 25,        // warn: review whether this should split
  "hardCap": 40,        // flag as bloated; splitting expected
  "requireSubsectionsAt": 15,  // MOC must have >1 "## " subsection past this size
  "minSourcesForNewMoc": 3     // existing lower bound, moved into config
}
```

Rationale for defaults: current vault has most MOCs <20; two outliers at ~39 and ~105. `softCap=25` flags the ~39 as "watch," `hardCap=40` flags the ~105 as "split now."

## 4. Detection — new deterministic lint check

Add `moc-size` check to `scripts/lint.ts` (sits alongside `moc-staleness`; reads `moc-index.jsonl`, which already carries `sourceCount`).

- `sourceCount >= hardCap` → severity **warn/error**: "MOC X has N sources (cap M); split into sub-themes."
- `softCap <= sourceCount < hardCap` → severity **info**: "MOC X approaching cap; review coherence."
- `sourceCount >= requireSubsectionsAt` with only one `## ` subsection → **info**: "flat MOC; add subsections."
- Register in the `checksToRun` list; surfaces automatically through `skills/wiki-lint` (read-only) since lint reports all checks.

## 5. Prevention — at ingest time

**`skills/wiki-ingest` (MOC Linking step):** before adding a source to a candidate MOC, read that MOC's `sourceCount` from `moc-index.jsonl`. Decision rule:
- If candidate MOC `< softCap` → link normally.
- If `>= softCap` → prefer a **narrower existing sub-MOC**; if none fits and the sub-theme has `>= minSourcesForNewMoc` members (incl. the new one), hand off to create a sub-MOC rather than growing the parent.
- Never grow a MOC past `hardCap`; if the only fit is a capped MOC, that's a signal the MOC needs splitting first — emit a note for autoimprove instead of piling on.

**`agents/wiki-moc-updater.md`:** add a guard — when adding a source would push a MOC `>= hardCap`, or when it's already flat and past `requireSubsectionsAt`, the agent adds the source under the best subsection **and** flags the MOC as split-needed (writes to lint/log surface), rather than silently growing it. It must not perform the split itself (out of scope for a haiku sync agent).

## 6. Remediation — splitting an oversized MOC

Splitting is a coherence judgment → needs a capable agent, not the haiku sync agent.

- **Owner (decision):** add a new `wiki-moc-splitter` agent, OR extend `wiki-domain-manager` (already the structural-restructuring agent). Recommend a dedicated `wiki-moc-splitter` for a single responsibility.
- **Input:** path to the bloated MOC + its member source records (title, concepts, tags).
- **Method:** cluster members by shared concepts/tags/sub-topic into 2–5 coherent sub-MOCs; propose names; create child MOCs via existing MOC-creation path; move source entries; update all `mocs:` frontmatter on affected sources; leave the parent as either a retired stub or an index-of-MOCs hub (decision below).
- **Invocation:** dispatched by `skills/autoimprove` during a new "moc-bloat" round when lint reports `moc-size` errors. Never auto-runs inside `wiki-ingest`.
- **Guardrails:** edit-only on moves; must preserve filename-stem wikilink contract; dry-run summary before writing.

## 7. Wiring into autoimprove

- `skills/autoimprove` gains a **moc-bloat round**: run lint `--check moc-size`; for each `hardCap` violation, dispatch `wiki-moc-splitter`; re-index; re-lint to confirm resolution.
- Order: run **after** stub/prune rounds (smaller graph first), **before** deep-linking (so new sub-MOCs exist as link targets).

## 8. Files touched (map)

| File | Change |
|---|---|
| `.wiki/config.json` | add `moc` block (caps, thresholds) |
| `scripts/lint.ts` | add `moc-size` check + register in `checksToRun` |
| `skills/wiki-lint` | (no code) doc the new check in its report legend |
| `skills/wiki-ingest` | MOC-linking step: soft/hard-cap decision rule |
| `agents/wiki-moc-updater.md` | guard: flag-don't-grow past cap; enforce subsections |
| `agents/wiki-moc-splitter.md` | **new** agent: cluster + split |
| `skills/autoimprove` | new moc-bloat round, ordered per §7 |
| `references/linking-rules.md` | note MOC-size principle |

## 9. Decisions to lock before build

1. **Caps** — accept 25 / 40 / 15, or tune to vault scale?
2. **Splitter ownership** — dedicated `wiki-moc-splitter` (recommended) vs. extend `wiki-domain-manager`.
3. **Parent MOC after split** — retire it, or convert to an "index of sub-MOCs" hub? (Recommend hub: preserves inbound links, becomes a coarse navigation layer.)
4. **Enforcement strength at ingest** — hard block past `hardCap`, or always allow + flag? (Recommend allow-but-flag; ingest should never fail on a structural-debt condition.)
5. **Retroactive pass** — one-time spl: run the splitter across all current `hardCap` violators, or only govern new growth going forward?
