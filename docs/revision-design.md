# Revision: changing an agent-maintained vault without losing what it used to believe

**Date:** 2026-10-28
**Status:** Design, decided. Nothing here is built. It supersedes the 2026-10-26 draft ("gloss") and the 2026-10-27 draft ("sublate").

**How it was reached:**
- Two research passes on AI memory systems.
- A five-agent adversarial engineering review.
- A seven-discipline research round: misinformation psychology, neuroscience of memory, developmental psychology, cognitive science of memory, world models, sociology of science, group cognition.
- A round on same-family agents as judges.
- A blind replay with the plan withheld or inverted.
- Seven reviews of the first draft (goals, bloat, evals, protocol attack, feasibility, two naming).
- An outside model (Codex) ran four rounds:
  - an engineering review;
  - its own cross-discipline research, without seeing ours;
  - a comparison that audited our citations and numbers;
  - a review of the autonomous-acceptance revision, which found the commit, rollback, scope and detector gaps fixed below.

**Scope:** how a vault maintained mostly by agents handles knowledge that newer work changes, corrects, bounds or disputes. It covers the commonplace changes needed to show that and the process agents follow to propose, accept, commit and roll back revisions. The process lives in commonplace, behind a versioned data schema; see Architecture.

**User-facing name:** *revision*. The command is `/vault revise`; the history tool is `vault_lineage`.

## Problem

An agent-maintained knowledge base builds a model of a field from sources over years. When new information conflicts with that model, it has to do several things:
- revise what it currently relies on;
- keep what it used to believe, where that came from, and why it was held;
- tell apart four different situations: the world changed, we were wrong, the old account still holds within a narrower range (Newton within Einstein), and the question is unresolved.

Mostly autonomous agents do the maintenance: several at once, across domains, from the same model family. The owner is one occasional input and never a required step. The reader of all this is a model answering questions, and it brings its own training priors.

**What exists today:**
- `supersedes:` and `contests:` frontmatter on the newer note (`hooks/lib/index/parse.ts` `FM_LINK_FIELDS`).
- Cards derive `supersededBy` and `contestedBy` from them (`hooks/lib/core/noun.ts:66-99`).
- Pointers print `⚠ superseded by [[X]]`.
- `agents/wiki-impact-checker.md` proposes edges at ingest.
- Ranking ignores age.

**Defects in that path:**
1. **The impact checker never weighs the old note's own claims.** It reads the new note's Summary and Contributions, but only the old note's Connections and Notes sections.
2. **It writes into the old note before anything is confirmed.** It adds an `[!update]` callout and `See also` lines to the old note's body, so LLM wording lands there and parallel writers contend for the same note.
3. **A label carries no reason and no scope.** "Superseded" covers the whole note even when only one claim was overturned.
4. **Concept notes and MOCs that absorbed a displaced claim are never marked.** `compiled-staleness` (`scripts/lint.ts`) fires only when a cited source is edited.
5. **A plain `Read` of a superseded file shows no label.**
6. **Dates print ahead of status.** LLM rerankers shift toward newer dates by up to 4.78 years in the top 10, with up to 25% preference flips (arXiv 2509.11353). The paper shows the bias; that printing status first removes it is our hypothesis.
7. **The index lock is not safe for anything beyond rebuilds** (`scripts/index.ts:114-142`):
   - After 120 s, a stale lock is taken over without an exclusive step, so two processes can both proceed.
   - Release removes the lock directory unconditionally, so a slow former holder can delete its successor's lock.
8. **The parser silently drops mapping-form edges** (`fmLinkStrings`). An unquoted value containing `": "` fails the whole frontmatter block.
9. **The session read trail is not proof of reading.** `hooks/register.tsx:1723` marks a `Read` of a vault note in the guard, before the read runs, keyed by note id with no version. It is good enough for the citation hint; it is not good enough to decide what an agent based a write on.

## The distinctions the data must carry

The design rests on four distinctions. The interface can stay small, but the records cannot merge any of them.

**1. Artifact, extract, decision, summary.**
- **Artifact:** the captured source (PDF, page, repo). It is never rewritten.
- **Extract:** the source note, an LLM's first reading of the artifact. It is an interpretation, not an observation. Extraction errors are corrected by a new version, never by silently editing it.
- **Decision:** an accepted judgment about how claims relate. These live in the ledger.
- **Summary:** concept notes and MOCs, the vault's current model. They are revised, and every revision records what it relied on.

**2. World change, retrospective correction, bounded applicability, unresolved, unreviewed.**

| Situation | Durable meaning | What the reader is shown |
|---|---|---|
| World changed | A new state with an evidenced effective time. The prior state stays true for its period. | The state for the relevant date, with conditions, worded as a change ("changed in [[X]]"), never as a correction |
| Retrospective correction | Our earlier reading or the evidence was wrong or unsupported. Record when we learned and accepted that. | The corrected account, or "unsupported" if no replacement is justified |
| Bounded applicability | The old claim stays useful within explicit conditions and tolerance. | "Supported within these conditions"; never a blanket retirement, and no claim about what happens outside them |
| Unresolved | Documented incompatible claims under comparable conditions, with evidence on both sides. | The disagreement and its practical consequence; abstain where needed |
| Unreviewed | No accepted judgment yet: evidence, access or review is missing. | Pending or unknown. It is never shown as contested. |

The formal basis for the first two rows is the difference between updating a description of a changing world and revising beliefs about a fixed one (Katsuno & Mendelzon). A retrospective correction must not pretend the claim became false on the day we noticed. A benchmark found flawed in October was flawed in March; the record should show we accepted it from March to October.

**3. Applicability is not time.** Einstein's own exposition treats Newtonian gravitation as a first approximation for weak fields and low velocities (*Relativity*, ch. XXIX). Newton gets conditions and a tolerance, never `valid_until: 1915`. A failure outside the tested range may expose an unjustified generalisation without refuting the measured claim. Limited testing also doesn't show the claim fails outside the range, which is why `bounds` says only where it is supported.

**4. Losing support is not refutation.**
- Withdrawing a justification makes it unavailable; it does not establish the opposite (Doyle's truth maintenance; de Kleer's assumption-based variant).
- If A and B support C, and D supports C independently, withdrawing A removes one support route. Its dependents get rechecked, not falsified, and their other support stays visible.
- A retraction can withdraw support without proving a result false. This is its own decision, `withdraws-support`, distinct from withdrawing a proposal.

**What "old" means:**
- `published` (display).
- `added` (bookkeeping).
- An accepted decision, the only kind of "old" that changes what the reader is shown.

Usage range (the span of dates of newer notes that link in) is cut:
- Anderson et al. 2023 fitted it to word recurrence in tweets and Reddit comments. That predicts accessibility, not truth.
- In-linking notes' `created:` dates are a bad proxy for when a link was made.

## Principles, with corrected citations

The human and animal findings below motivate hypotheses about this system; they don't demonstrate effects in it. Where a finding is narrower than it first sounds, the scope is stated.

1. **Retain everything; select per question.**
   - Old traces survive while their accessibility changes. This is the storage-strength vs retrieval-strength distinction (Bjork & Bjork 2020, a theoretical framework), and context-gated extinction (Bouton 2004; Lacagnina et al. 2019 in mice).
   - That supports never erasing history. It does not support pulling every superseded passage into every answer.
   - When an old claim is served, its correction or scope travels with it.
2. **A correction repairs the inference.**
   - A short causal replacement reduced readers' confusion, but the outdated information still came back to mind; a fuller explanation removed both effects (Kendeou et al. 2013).
   - Explaining whether the original report was a lie or an error added nothing (Connor Desai & Reimers).
   - So `because` states what follows now, under which conditions, and on what evidence. It does not state who erred.
   - Coherence-based corrections had larger effects than fact-checks in a meta-analysis, r = .55 vs .25 (Walter & Murphy 2018). These are effect-size summaries, not success rates.
   - Putting the current state first is a UI hypothesis to test. A direct format experiment found no advantage for the truth sandwich over refutation-first (Swire-Thompson et al. 2025).
3. **Revise the summary; check it in use.**
   - Naive models persist in experts. Adults verify statements more slowly and less accurately where intuition and science conflict (Shtulman & Valcarcel 2012).
   - Children's causal understanding is assessed through what they can do with it (Gopnik et al. 2001).
   - So a revision is judged by whether downstream reasoning changes, not by whether the reader can repeat a status.
   - A vault can hold locally incompatible accounts without one coherent theory. Nobes et al. 2003 collected new data with different methods and found fragmented knowledge, against Vosniadou & Brewer's coherent synthetic models. Global coherence repair is therefore not a goal.
4. **Contest requires evidence.**
   - Lack of evidence is "unreviewed", never "contested" or "unresolved".
   - Before declaring a contradiction, a reviewer asks what conditions would make both claims compatible and what observation would tell them apart (Johnson-Laird 2010). Entity, population, version or scope mismatches show up here.
5. **Judgment changes on evidence, not on age.**
   - Prediction error was necessary for reconsolidation in one human fear-learning protocol (Sevenster et al. 2013), so evidence-changing events are what trigger revision.
   - Age never demotes a claim: late recognition is a continuous spectrum (Ke et al. 2015).
   - A scheduled discovery job is out of v1; see Protocol.
6. **Independence comes from the information path, not the number of agents.**
   - Groups favour shared information over what one member holds alone (Stasser & Titus 1985). Social information reduced the diversity of estimates without improving accuracy (Lorenz et al. 2011). Sequential observation produces cascades (Bikhchandani et al. 1992).
   - Three summaries of one experiment are one piece of evidence.
   - LLM evidence, scoped:
     - When two models both err on four-option questions, they pick the same wrong option about 60% of the time against 33% chance, and this holds across providers too (Kim et al., ICML 2025).
     - Majority voting explains most debate gains in the seven benchmarks studied (Choi et al., NeurIPS 2025).
     - Mixed-model debate configurations dropped 8 and 12 points in Wynn et al. 2025, with a gain in another configuration.
     - A shown prior verdict cut correction from 21.6% to 11.3% in one GPT-4.1 categorical experiment. A warning improved the paired effect there, but did not remove the total effect in the numerical task (Kapetanovic et al. 2026).
     - Chain-of-Verification answers verification questions without the draft in context. It is a same-model method and does not check against outside artifacts.
     - Trained critics help humans find code errors (CriticGPT, McAleese et al.). That doesn't validate untrained same-family reviewers.
   - So: isolate first judgments, vary the evidence and the checks, and measure joint failures in this workflow. Another model family is an experimental arm, not a guarantee.
7. **A human check is not an oracle.**
   - People accept what an aid proposes and miss what it doesn't flag (Parasuraman & Manzey 2010).
   - Assisted annotation changes the reference standard itself. GPT-4's weighted F1 was .47 against unassisted labels and .79 against GPT-assisted ones (Schroeder et al. 2025).
   - The owner controls policy, access and pausing. The owner's factual assertions are evidence like any other and stay open to later evidence.
   - Eval labels are prepared without seeing the proposed verdict.
8. **Corrections don't propagate on their own.**
   - Years after trials contradicted them, 10 of 16 and 29 of 47 evaluable 2006 citations to two selected claims were still favourable (Tatsioni et al. 2007). Favourability was associated with whether the contrary trial was mentioned.
   - In one retraction case, 107 of 112 direct post-retraction citations failed to mention the retraction, and 23 of 152 sampled second-generation citations were possible diffusions of the faulty claim (Schneider et al. 2020).
   - So citations are candidates for recheck, and a dependency receipt says what a summary actually relied on. Descendants are traced and inspected, not all auto-labelled.
9. **Repetition isn't evidence.** Repetition raises perceived truth even when people know better (Fazio et al. 2015). Agents restating a source add nothing. History stays available without flooding ordinary answers.

## Architecture

**Everything stays in commonplace.** The reducer, the accepted projection, display, scope enforcement, the commit step and the proposer live together, behind an internal interface with a versioned on-disk schema.

A separate maintainer plugin is deferred until a second real consumer, or a separate release or permission boundary, needs it. That plugin could propose and submit review evidence through `$.commonplace`, but never bypass the acceptance invariants.

**Trust model:**
- **Only the reducer creates accepted state.** An edge is accepted when a committed `accept` event exists for it, whichever tool wrote the frontmatter. A write through commonplace's own tools is not acceptance.
- Any other change to those keys is a **candidate**:
  - an Obsidian edit;
  - Bash;
  - a model Write/Edit, including through commonplace's tools;
  - another plugin or session;
  - sync, including a pull from another machine;
  - commonplace's own `supersede --retire`, until it goes through the reducer.

  The sweep records a candidate as `external`. In autonomous mode the projection keeps showing the previous accepted state until the reducer admits the change.
- **Manual mode is explicit.** A vault without agent revision sets `revision: manual` in `.wiki/config.json`, and then hand-written edges display, marked unreviewed. A vault in autonomous mode never silently falls back to displaying unaccepted frontmatter.
- Owner authority comes only from an authenticated runtime action tied to a specific event: a slash command, or a dialog button. It never comes from a model-written `onBehalfOf` field or an interpretation of a typed prompt.
- The guard on Write/Edit and Bash is a best-effort guard, like the existing ones. It is not an OS boundary, and nothing here claims "no bypass". Manual `git` ignores every commonplace lock; the commit step detects such commits and reconciles rather than assuming they can't happen.

**Cross-machine boundary:** v1 has one authoritative writer host. The vault may sync; a second machine's agents propose but never accept or commit revisions. Changes that arrive by sync are candidates. That holds until a specified merge protocol exists.

## Data

### Accepted edges (frontmatter on the newer note)

```yaml
supersedes:
  - note: "[[Acme Study 2026]]"
    claim: "reaches 71% on BenchX"
    because: "the same benchmark with the test-split leak removed scores 58%; claims built on the 71% figure no longer follow"
    kind: correction
bounds:
  - note: "[[Classic Result]]"
    claim: "effect size is stable"
    within: "samples under n=1000"
    because: "reproduced below n=1000; reverses above"
contests:
  - note: "[[Gamma Survey]]"
    claim: "method X outperforms Y"
    because: "a larger replication under the same conditions finds the reverse; neither has been reconciled"
withdraws_support:
  - note: "[[Delta Analysis]]"
    claim: "the effect is causal"
    because: "the dataset it relied on was retracted; no replacement evidence either way"
```

- **`claim` is required** for `bounds`, `withdraws-support` and any partial displacement. `within` is required for `bounds`.
- **A whole-note edge is never accepted autonomously.** An edge with no `claim` is legal (manual mode, legacy edges), but the reducer only accepts claim-scoped edges. A proposal whose claim can't be located is refused, not widened to the whole note.
- **`kind`** is `correction` or `world-change` on `supersedes`. A world change may carry `effective: 2026-06-01`; unknown stays absent.
- **`claim` is matched exactly** against the old note's current body.
  - A quote that occurs twice is ambiguous and refused.
  - A quote that stops matching makes the edge stale, reported by lint and shown as "claim no longer found". It never silently rebinds to new prose.
- **Rendering:**
  - `bounds`: "claim … supported within …".
  - `supersedes` with `kind: correction`: "claim … corrected by [[X]]: …".
  - `supersedes` with `kind: world-change`: "claim … changed in [[X]] (effective …): …"; the old state stays true for its period.
  - `withdraws-support`: "claim … lost its support in [[X]]: …"; not "refuted".
  - "superseded" alone is used only for legacy whole-note edges.
- **Quoting:** `because` is always quoted.
- **The plain form** `supersedes: ['[[X]]']` stays valid and shows "(no reason recorded)".
- **Nothing is written on the old note.** Its status is derived.

### The ledger

Append-only events, one file per session, so concurrent sessions and sync never interleave a file:
- Public: `<vault>/.wiki/revision/<session>.jsonl`.
- Private: under `.wiki/sealed/<shard>/revision/`.
- Each line is one complete JSON event written with a single append; readers skip a torn last line. No size limit is imposed.
- The guard denies model writes to these paths.
- Ledger files are committed with the revision they record (see the commit step), and a revert never removes them.

```json
{"id":"01JB…","seq":null,"kind":"propose","actor":{"agent":"a91…","type":"commonplace:wiki-impact-checker","session":"…"},
 "claim":{"note":"Acme Study 2026.md","text":"reaches 71% on BenchX","rev":"sha256:…"},
 "against":{"note":"Zeta Retriever.md","rev":"sha256:…"},
 "evidence":[{"artifact":"sha256:…","locator":"p.6 §4.2","extract":"sha256:…"}],
 "inputScope":["public"],"policy":"v1"}
```

- **Kinds:** `propose`, `review`, `accept`, `reject`, `withdraw` (a proposal), `revert`, `external`, `compile`, `checked-no-change`, `committed`, `pending`.
- **Identity and basis:**
  - event id;
  - the claim's note, exact text and content hash;
  - the other note's hash;
  - an **evidence packet**: artifact hashes, locators, the conditions examined and the extract revision;
  - source lineage, so two notes summarising one paper count once.
- **Workflow:**
  - actor and session;
  - recorded time;
  - accept sequence (`seq`), assigned only at commit;
  - policy version.
  - A rejection means the proposal was rejected, not that its negation is true.
- **Input scope** is the set of scopes of every input that reached any step: the proposer's context, the candidate text, cached verifier results, the reviewers' and compilers' inputs, and the step that rewords `because`. It is carried forward through the whole pipeline, not computed at the end.
- **Never logged:** prompt text.

### The commit step: git as the history layer

The vault is already a git repository, but commits are manual and infrequent. **Agents make the commits, because they know when a unit of work is done.** Git commits whole files, not one writer's changes, so "stage the files this agent wrote" is not safe on its own: if the owner edits one paragraph and an agent another paragraph of the same file, committing the file takes both. The commit step works on units instead.

**A unit of work** is one ingest, one compile, one accepted revision, or one edit task. The module records, for each unit:
- unit id and actor;
- the base commit (`HEAD` when the unit started);
- each path it touched, with the blob before and after its writes.

**`commonplace commit --unit <id> --message …`** commits a unit only when it is complete and clean:
- Every path's working-tree blob still equals the unit's recorded "after" blob, and its "before" blob equals the path's blob at the base commit. A path anyone else changed fails this check.
- The commit is built from those blobs in a temporary index (`GIT_INDEX_FILE`), never from the owner's index, so the owner's staged changes are untouched.
- The new commit's parent is the expected `HEAD`, and the branch moves with `git update-ref <ref> <new> <expected-old>`. If someone committed in between, manual commits included, the step rebases the unit's blobs onto the new `HEAD` when the paths are disjoint, and otherwise reruns the check.
- A unit that fails retries a bounded number of times. One that still conflicts is logged with the conflicting paths and left uncommitted for its own session to redo; nothing is overwritten and nothing asks the owner.
- An empty unit is refused. `git add -A` is never run.
- A unit whose path another writer changed since (another unit, or the owner) is not committed for that path set: the check fails, the files stay as written, and the conflict is logged. Built without worktrees; a patch-in-worktree path is only worth adding if conflicts turn out common in the logs.
- The pinned branch is the vault's current branch at session start. A detached `HEAD` or a different branch pauses committing and logs why.

**Trailers** carry only opaque ids: `Revision-Event: <id>`, `Unit: <id>`, `Actor: <agent type>`. Reasons, relations and titles stay in the scoped ledger, so a commit message never carries private text. Git history is shared across scopes, so `vault_lineage` and every history tool enforce the session's scope before showing a commit's content.

**Accept order: prepare, commit, publish.** An accepted label never goes live without the commit behind it.
1. **Prepare:** under the lock, recheck the inputs (see Protocol), assign `seq`, and write an `accept` event marked `prepared` with the expected parent commit.
2. **Commit:** build the commit containing the frontmatter change, the ledger lines and any projection files, through the unit procedure above.
3. **Publish:** append a `committed` event binding `accept` id ↔ commit hash, then update the projection.

Recovery at each boundary:
- A `prepared` accept with no commit is retried from step 2 or abandoned to `pending`.
- A commit whose `Revision-Event` trailer has no `committed` event gets one; the projection is rebuilt.
- The projection is always rebuildable from committed accepts and nothing else.

**Rollback is a compensating revision.** `/vault revise undo <event|last>` (or the notice's Undo; agent- or owner-invoked):
- appends a `revert` event; the ledger stays append-only;
- withdraws the decision from the projection immediately;
- marks every dependent passage unverified at once, then queues them for recompile;
- commits the inverse of the frontmatter change, applied to the current text, so later edits survive. If the inverse no longer applies (the edge was edited since), the revert still withdraws the decision and logs the conflict; the frontmatter is reconciled by the next reducer pass, since the reducer, not the file, decides what is accepted.

A manual `git revert` of a revision commit is detected through its trailer and recorded as a `revert` event, so a projection rebuild doesn't resurrect the decision.

**Limits:**
- **A revert doesn't recall answers already given**, so false-label harm is still measured.
- **Text in a commit message is hard to retract**, which is why commit messages carry only ids.
- **Sync risk:** a `.git` directory inside a cloud-synced folder can be corrupted by sync. `commonplace` detects a synced vault folder and warns.

### Dependency receipts

Every compiled concept passage records:
- a hash of the passage text itself;
- the claim ids, content hashes and decision versions it was built from.

A passage is fresh only while its own hash still matches and every input is unchanged. A passage edited by hand, or one whose support was withdrawn or reverted, is no longer fresh.

A passage becomes fresh again only once:
- a verified compile covers its current inputs; or
- a `checked-no-change` receipt records that it was checked against those exact versions.

Receipts are written lazily: when a passage is compiled or checked, not as a backfill. From the first release, an accept or revert marks dependents stale immediately. A passage with no receipt that cites a displaced note is found by the `stale-derivation` lint.

### Accepted projection

The frontmatter labels, cards and `## Changes` lines are views generated from committed accept events, and can be rebuilt from them. Accepted prose and the text it replaced are in git, so a past decision can be reproduced without rerunning an old model.

## Protocol

**Triggers.** Revision is a standing direction tied to work, not a scheduled budget.
- **The main trigger is a vault write made after related notes were read.** For example, an agent explores, decides an article is useful, and writes or edits a note. A read alone triggers nothing.
- **Read evidence:** the module records completed reads only (the tool result arrived), each with the note's content hash at that moment. This replaces the guard-time marking in defect 9 for revision purposes.
- **Candidate pool:**
  - the written note;
  - the related notes the session read, at the versions read;
  - notes the graph links to it;
  - a `vault_search` over the written claims, so a related note the session never opened is still considered.

  Empty pools and pools truncated to fit are logged.
- **The check:** haiku decides whether any claim needs reconciling. If so, it proposes.
- **Jobs are durable:** enqueued to the ledger, debounced per unit of work (one job when the unit finishes, not one per write), deduplicated by evidence revisions, with bounded concurrency and bounded retries.
- **Generated writes never trigger jobs:** writes by the accept step, projection repair, a revert or a compile carry their origin and are skipped.
- An ingest is the same case: it writes a note related to existing ones.
- **Secondary triggers:**
  - an `external` candidate;
  - a `freshen` URL change;
  - a stale-dependency hit.
- **Recheck on use:** before a note carries an answer in a domain the owner marked fast-moving, check its sources for changes. If the evidence can't be reached, the note shows "source unverified", which is not "contested".
- No periodic discovery job in v1.

**Detector audit.** Haiku's misses are invisible to everything downstream, so they are measured on their own:
- invented miss cases (fixture pairs with a known relation) are run through the check;
- a sample of haiku's "nothing to reconcile" answers is rechecked by a stronger model, and disagreements are logged;
- misses are reported separately from reviewer errors.

**Propose:**
- The proposer reads both notes in full and names the specific claim.
- It writes a proposal with no verdict shown to reviewers.
- The cap is three proposals per unit of work. Excess proposals are queued, not dropped.

**Review:**
1. The question is generated by code: the two claims, their conditions, and the available evidence. It offers every outcome:
   - correction;
   - world change;
   - bounded;
   - support withdrawn;
   - unresolved disagreement;
   - no relation;
   - insufficient evidence.

   The proposer's wording and verdict are withheld. Claim order is randomised; the relation being tested is kept fixed.
2. Each reviewer is a single history-free `$.model.complete` call with both notes pasted in. A spawned agent isn't verifiably zero-context, and commonplace's own spawn hook would rewrite its prompt.
3. The reviewer commits an assessment with quotes from both notes.
4. For **every** relation, an **evidence verifier** goes back to the artifacts. Two bad extracts can produce a confident false dispute as easily as a false correction. Using the stored artifact hashes and locators, it retrieves the relevant original passages with their context itself; it does not use the proposer's quotes. It then checks each note's claim and conditions against them.
   - Results are cached by artifact, claim, scope and verifier version. A cached result carries its input scope.
   - It escalates to the full source only when the passages are inadequate.
   - It abstains when the source can't be reached.
5. Only after committing does the reviewer see the proposer's rationale, and only to improve the wording of `because`. The final `because` may state only what the verifier confirmed; a check rejects wording that adds a claim. Any reviewer whose verdict would have flipped on seeing the rationale is logged.

**Accept**, in one deterministic step with no model calls inside it:
- Take the lock: a lock directory created by one atomic `mkdir`, owned by the process for the short prepare-and-commit section and taken over only when its owner process is dead (same host, `kill(pid, 0)` fails) or it has no owner file for 30 s — never on age (Node has no `flock`; `scripts/lib/revision/lock.ts`). The fence is the commit itself: it lands with `update-ref` against the expected parent, and a holder that lost the lock does not publish.
- Recheck:
  - both notes' content hashes;
  - the cited evidence hashes;
  - the current accepted graph;
  - the target concept's revision;
  - the input scope against the session's currently open shards.
- Then prepare, commit, publish (see the commit step).
- **Idempotence** is keyed on (claim identity, other claim, relation, scope, evidence packet), not on the note pair.

| Relation | Accepted when |
|---|---|
| unresolved (`contests`) | one blind review finds incompatible claims under overlapping conditions, and the verifier confirms both claims against their artifacts |
| correction, bounded (`supersedes`, `bounds`) | blind review agrees and the verifier confirms against the artifact |
| world change | blind review agrees and the verifier confirms the new state, with an evidenced effective time if one is claimed |
| support withdrawn | blind review agrees and the verifier confirms the withdrawal (a retraction notice, a corrected dataset) |
| anything uncertain | stays pending; not an edge, not a label |

Because every accept is a single revertible commit, acceptance is autonomous from the start once the conditions above hold. There is no owner queue in front of it. The reviewer eval measures error and sets how strict the conditions are; it does not gate whether agents may accept.

**Nothing waits for a human.** An uncertain case escalates once, to a stronger model that reads the full original source. If that stays uncertain, the case is recorded as `pending`: no edge, no label. Pending cases are visible through `vault_lineage`, but nothing depends on anyone looking at them.

**Reject and reopen:** a rejected or pending case reopens only when its evidence packet changes: a new artifact, a changed artifact hash, a newly examined locator, different conditions, or a corrected extract. A new filename that summarises the same source doesn't reopen it. An owner remark reopens a case the same way, as one more piece of evidence in the packet; it doesn't settle the case.

**Compile:**
1. On accept or revert, the receipts list the affected passages. They are marked stale immediately; only those are queued.
2. One compiler revises each passage and adds a `## Changes` line; one verifier checks it against the cited evidence.
3. One bounded cycle; no relay of agents revising each other's output.
4. A revert re-queues dependents rather than restoring old text over later edits.
5. Compiler writes carry their origin and never trigger new revision jobs.

**Scope** (the most severe review finding):
- Public text is produced and verified only from public inputs. Input scope is the union described in the ledger section, so a private note in the proposer's context makes the whole revision private.
- **v1 limit:** a revision's inputs are public notes plus at most one private shard. A revision that would need two private shards is not proposed.
- A private revision stays in that shard's ledger as a shard-scoped label. A public revision of the same claim happens only if an agent re-derives it independently from public evidence, with a fresh public-only context. There is no declassification step.
- Scope is checked again at commit, since the shard may have closed in the meantime.
- Reviews of public pairs run with sealed domains closed.
- The private-title leak check runs on `because` text.
- Title masking can't catch paraphrase (`hooks/lib/guard.ts` says so). The input-scope rule is the defence.

**Loops** (there is no daily budget; work follows writes):
- Durable job deduplication keyed by evidence revisions.
- Bounded retries with backoff; bounded concurrent jobs.
- Generated writes never trigger jobs (see Triggers).
- A durable pause (`/vault pause-revision`) checked at commit across sessions. Per-agent caps alone are evaded by new session ids.
- Text from a fetched page never reaches a concept note without review. Memory-injection attacks succeeded at injecting records 98.2% of the time in MINJA, with 76.8% downstream attack success (arXiv 2503.03704).

**Owner:** no step in the process requires the owner. Acceptance, rejection, escalation, commit, rollback and recovery are all done by agents.
- **Optional actions:**
  - `/vault revise undo <event|last>` and `/vault revise pause|resume`;
  - a remark in conversation ("that's wrong"), which enters the case's evidence packet and reopens it.
- **Every owner intervention is logged as a failure signal:** a revert, an override, or a correction the agents missed means the process got something wrong. A low intervention rate is not evidence of precision, since it may only mean nobody looked; see Evaluation.

**History:**
- `vault_lineage` shows how a claim or concept changed: the accepted sequence, each event's reason, and the text it replaced, filtered to the session's scope.
- It can answer "what did we accept as of date X" because accepted text is in git and evidence hashes are in the ledger. It does not reconstruct a page that has since changed, unless the artifact was snapshotted.

## Serving rule

- Use the accepted current projection when it is relevant and its dependencies are current.
- Expose uncertainty and retrieve evidence for uses that are disputed, stale or out of scope.
- When an old claim is served, include its correction, change or scope with it.
- Historical questions may deliberately retrieve earlier versions.
- The absence of a `contests` edge is not evidence that a summary is reliable.
- Status prints before the date on every surface:
  - pointers;
  - `vault_note`'s header;
  - `vault_links`;
  - MOC listings;
  - the connection card;
  - prime;
  - a note on a plain `Read`, through the `tool.call{Read}` hook.
- One hop of chaining: "corrected by [[X]]; [[X]] is itself disputed by [[Y]]".

## Bitemporal: what is in, what is out

**In now:**
- Recorded history with an unambiguous commit order (`seq`, and git order).
- Optional evidenced effective dates on world-change claims only.
- Applicability conditions, independent of time.
- Prior accepted text preserved in git.
- Publication dates stay publication dates, and an unknown effective time stays unknown.

**Out for now:**
- a temporal graph database;
- interval algebra;
- extracting validity intervals for every scientific claim;
- a two-time query language.

Replaying the ledger answers audit questions.

**Trigger to add the rest:** recurring real questions or failing eval cases of the form "what held at world time V, according to what we knew at time T". Backdated changes, reopened intervals and temporal joins across claims are the signs. Zep/Graphiti already implements bitemporal edges. Its rule that newer information invalidates older overlapping edges is wrong for science, because a later paper can be the mistaken one.

## First shipment: autonomous acceptance, with git as the safety net

Agents accept revisions from the first release. Nothing is lost because every write lands in a git commit first: the commit layer is built and tested before anything else writes through it, and every accept, compile and revert is a commit that `/vault revise undo` or plain git can undo.

Built in this order, each step resting on the ones before:

1. **Git first.** Units of work and `commonplace commit`: the unit record (base commit, before/after blobs), the clean-unit check, the temporary index, `update-ref` with the expected parent, bounded retry, and agent calls at the end of an ingest, compile or edit. Before the module lets any revision write, it checks that the vault is a git repository on a pinned branch; if not, revision runs propose-only and the band says why. Tested on its own against concurrent owner edits and manual commits.
2. **Display.** Status before date on every model-facing line.
3. **Claim-scoped edges:**
   - mapping form with `note`, `claim`, `because`, `within`, `kind`, `effective`;
   - `bounds` and `withdraws-support` added, each with its own rendering, and world change rendered apart from correction;
   - parser (fixing the silent drop in defect 8), edge storage (`csr.ts` stores only the edge kind today, so reasons need a side table), `EDGE_KINDS`, card field (a minor `apiVersion` bump), `SCHEMA` bump.
4. **The impact checker** stops writing into old notes, reads both notes in full, and emits proposals into the ledger.
5. **The ledger and the reducer:** input scope carried as a union, the v1 scope limit (public plus one shard), the reducer as the only source of accepted state, explicit manual mode for vaults without revision.
6. **Accept:** the owner-liveness lock with fencing; prepare, commit, publish with recovery at each boundary; one blind review plus the evidence verifier for every relation; one stronger escalation, then pending.
7. **Revert:** compensating revert, including reconciliation of a manual `git revert`.
8. **Triggers:** completed-read tracking with versions, and the durable write-trigger job queue with debounce and generated-write suppression; the detector audit.
9. **Dependents:** immediate invalidation on accept and revert, lazy receipts, and the `stale-derivation` lint as a candidate finder (a concept or MOC cites a displaced note, whether or not it also cites the replacement, and has no current receipt; cleared by a receipt, not by adding a citation).
10. Rewrite the CLAUDE.md section "Note age is shown, never decayed" around these distinctions.

Deferred: mixing several private shards, plugin extraction, broad concept compilation, temporal queries.

## Evaluation

**Phase 0** (free, agent-run):
- An agent samples real answers and concept notes for displaced claims, using the blind protocol below; the owner is not asked to read anything.
- Measure the proposal rate per ingest, including the `[!update]` callouts the checker has already written.
- A count of confirmed edges proves nothing while the detector is defective.

**`eval:staleness`**: does presentation help the reader, separated from the evidence behind it?
- Each current-state item is paired across four arms, with the same evidence in every arm:
  - **U:** unlabelled;
  - **B:** today's label;
  - **C:** a correct status-first label with `because`;
  - **E:** a false label in C's format.
- A closed-book probe per item records what the model answers with no notes. That is its observed prior, not its training data.
- Invented, counterbalanced values and entity names.
- **Strata:** world change, correction, bounded, support withdrawn, unresolved, unreviewed, historical, timeless; downstream questions that embed the old assumption; copied-source pseudo-corroboration; withdrawal with alternative support; stale concept summaries.
- **Pilot size:**
  - 120 current-state items × 4 arms × 3 runs = 1,440 calls;
  - 120 closed-book probes;
  - 60 historical, timeless or bounded items × 4 arms = 240.
  - About 1,800 calls in all. That is a pilot for the small strata, not proof of zero historical harm.
- If concept compilation ships, keep a small regression slice for stale and corrupted summaries. It tunes the compiler; it does not gate it.
- **False-label harm** is excess error relative to the same item's unlabelled arm. C vs E measures reliance on the whole status-and-reason packet, not on a bare label.
- **Statistics:** paired confidence intervals over independent items. Repeated runs are not new items.
- **Cut:** the bare-"newer" arm, usage range, self-vs-other attribution, and full factorial permutations.
- Status-before-date ships without waiting for this. It is cheap and reversible, and the date-bias result is reason enough to try it; this eval then tests whether it helps.

**Acceptance accuracy** (`eval:revision`):
- **Measure** the false discovery rate among accepted proposals, by relation, on a representative proposal stream, plus recall.
- **Compare**, at matched cost:
  - a single independent review;
  - aggregated independent reviews;
  - review plus the evidence verifier.
- **Labels** are prepared blind to the proposed verdict, without asking the owner to label anything:
  - **invented fixtures** whose correct relation is known by construction;
  - **real proposals** labelled by the strongest available model reading the original artifacts under the blind protocol, with a different model family where one is configured. Its agreement with the pipeline is reported as agreement, not as accuracy.

  Near-duplicate papers are clustered.
- **Sample size:** with zero errors in n independent accepted proposals, the one-sided exact 95% upper error bound is about 9.5% at n=30, 5.8% at n=50, and just under 5% at n=59. Thirty to fifty labelled proposals are pilot data, not certification.
- **Tolerated error** is tied to downstream harm and fan-out. A wrong edge copied into ten central concepts costs more than one on a rarely read leaf.
- Planted-wrong acceptance is an adversarial test, not production precision.

**Live**, from the ledger, each reported separately and never folded into one number:
- fixture accuracy, by relation;
- agreement with the strong-model labeller;
- detector misses (from the detector audit);
- accepted-then-reverted, per relation, split by who reverted (an agent or the owner);
- verifier abstentions and the pending backlog;
- flips;
- owner interventions per accepted revision (each one a failure; a low rate alone proves nothing);
- reversals, read rather than counted. Most apparent Wikipedia bot conflicts turned out to be routine work (Geiger & Halfaker 2017).

## Phases

0. Agent-run sample and proposal rate.
1. First shipment (above), autonomous acceptance on. It doesn't wait for any eval.
2. `eval:staleness` pilot and `eval:revision`, run against the live system: measure error by relation and tune the acceptance conditions.
3. Compile flow for affected passages, tuned by the summary slice of `eval:staleness`.
4. Extract a maintainer plugin only if a second consumer appears.

## Decisions

Decided 2026-10-27 and 2026-10-28:
1. **Error tolerance:** wrong revisions are cheap because every one is a revertible commit. Acceptance is autonomous; the eval tunes strictness rather than gating autonomy. No step requires the owner: having to accept, label or clear a queue would itself be a failure of the design.
2. **Commits:** agents commit, per unit of work, because they know when a unit is done. Autonomous acceptance ships in the first release; git is what keeps data from being lost, so the commit layer is built first.
3. **Budget:** none as such. Revision triggers when a write follows reads of related notes, with a haiku check deciding whether to propose.
4. **Two-time questions:** later.
5. **Old material in answers:** the current view plus its correction, change or scope; history on request.
6. **Name:** revision, `/vault revise`.

## Not building

- **Argumentation semantics, a reinstatement calculus, a general belief calculus, AGM over prose.** They turn label noise into confident verdicts.
- **Global coherence repair.** Incompatible local accounts are allowed.
- **Numerical confidence or strength scores.** There is no defensible likelihood model, and counts reflect what was ingested.
- **Continuous replay, sleep-like consolidation phases, age-based thresholds.**
- **Debate rounds and persona voting.** Picking the best persona per question beats chance as an upper bound, but most practical strategies for predicting it were only marginally better than random, and some worse (Zheng et al.).
- **A graph database or temporal store.** The ledger plus git plus a rebuildable index is enough.
- **Usage range, resurfacing, citation flow as truth.**
- **A query-type classifier that hides notes.**
