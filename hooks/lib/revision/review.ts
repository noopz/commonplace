/**
 * The model calls of revision (docs/revision-design.md, "Triggers",
 * "Propose", "Review"): prompts and strict parsers, pure so tests pin them.
 *
 *   detect   haiku: does a just-written note bear on any candidate's claims?
 *   propose  quote, verbatim, the one claim of the older note it bears on
 *   review   blind: the code asks the question, every outcome offered,
 *            claim order randomised, the proposer's verdict withheld
 *   verify   the original sources' passages (retrieved by commonplace, not
 *            the proposer) against the claim and the decision
 *   escalate once, a stronger model reading the full sources itself
 *   wording  after committing, `because` reworded — and checked to add nothing
 *
 * Every reply is JSON; anything unparseable is "no answer", never a verdict.
 */

import type { RevisionRelation } from "./edges.ts";

export const MODELS = { detect: "haiku", propose: "sonnet", review: "sonnet", verify: "sonnet", escalate: "opus", wording: "sonnet", wordingCheck: "haiku" } as const;

export const NOTE_CHARS = 20_000;
export const DETECT_NOTE_CHARS = 5_000;

function json<T>(text: string | undefined): T | null {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);

// ------------------------------------------------------------------ detect

export const DETECT_SYSTEM =
  "You maintain a knowledge base of notes summarising sources. A note was just written. Decide, for each older candidate note, " +
  "whether the new note plausibly CHANGES what that older note claims: corrects it, reports that the world changed since, " +
  "shows it holds only under narrower conditions, contests it with comparable evidence, or removes the evidence it rested on. " +
  "Agreement, elaboration, a different topic, or merely citing the same work is NOT a change. Most candidates are not changed; " +
  'an empty list is the usual answer. Reply with JSON only: {"changed":[{"n":<candidate number>,"why":"<one short clause>"}]}';

export function detectPrompt(written: { title: string; text: string }, candidates: ReadonlyArray<{ title: string; abstraction: string }>): string {
  return [
    `NEW NOTE: [[${written.title}]]`,
    clip(written.text, DETECT_NOTE_CHARS),
    "",
    "OLDER CANDIDATES:",
    ...candidates.map((c, i) => `${i + 1}. [[${c.title}]] — ${c.abstraction || "(no summary)"}`),
  ].join("\n");
}

export function parseDetect(text: string | undefined, n: number): Array<{ n: number; why: string }> | null {
  const j = json<{ changed?: Array<{ n?: unknown; why?: unknown }> }>(text);
  if (!j || !Array.isArray(j.changed)) return null;
  const out: Array<{ n: number; why: string }> = [];
  for (const c of j.changed) {
    const k = Number(c.n);
    if (Number.isInteger(k) && k >= 1 && k <= n && !out.some((o) => o.n === k)) out.push({ n: k, why: String(c.why ?? "").slice(0, 200) });
  }
  return out;
}

// ----------------------------------------------------------------- propose

export const PROPOSE_SYSTEM =
  "You read two notes in full. Find the ONE specific claim in the OLDER note that the NEWER note bears on (corrects, changes, bounds, " +
  "contests, or removes support from). Quote it EXACTLY as written in the older note — a sentence or clause, copied character for " +
  "character, long enough to occur only once. Do not say what the relation is. If the newer note does not bear on any specific " +
  'claim, answer null. Reply with JSON only: {"claim":"<exact quote>"|null,"rationale":"<one sentence: what in the newer note bears on it>"}';

export function proposePrompt(older: { title: string; text: string }, newer: { title: string; text: string }): string {
  return [`OLDER NOTE: [[${older.title}]]`, clip(older.text, NOTE_CHARS), "", `NEWER NOTE: [[${newer.title}]]`, clip(newer.text, NOTE_CHARS)].join("\n");
}

export function parsePropose(text: string | undefined): { claim: string; rationale: string } | "none" | null {
  const j = json<{ claim?: unknown; rationale?: unknown }>(text);
  if (!j) return null;
  if (j.claim === null || j.claim === undefined || j.claim === "") return "none";
  if (typeof j.claim !== "string") return null;
  return { claim: j.claim.trim(), rationale: String(j.rationale ?? "").slice(0, 600) };
}

// ------------------------------------------------------------------ review

export type ReviewVerdict = {
  verdict: RevisionRelation | "none" | "insufficient";
  kindOf?: "correction" | "world-change";
  within?: string;
  effective?: string;
  because?: string;
  quotesOld: string[];
  quotesNew: string[];
};

const OUTCOMES: Record<string, Pick<ReviewVerdict, "verdict" | "kindOf">> = {
  correction: { verdict: "supersedes", kindOf: "correction" },
  "world-change": { verdict: "supersedes", kindOf: "world-change" },
  bounded: { verdict: "bounds" },
  "support-withdrawn": { verdict: "withdrawsSupport" },
  unresolved: { verdict: "contests" },
  "no-relation": { verdict: "none" },
  insufficient: { verdict: "insufficient" },
};

export const REVIEW_SYSTEM =
  "You are an independent reviewer judging how two notes' claims relate. Judge only from the two notes given. Before deciding, " +
  "ask what conditions would make both claims compatible (different entity, population, version, scope, time, or measurement) " +
  "and what observation would tell them apart; most apparent contradictions dissolve there. Then choose exactly one outcome:\n" +
  "- correction: the earlier claim was wrong or unsupported all along (it did not become false when noticed)\n" +
  "- world-change: the claim was true for its time; the world has since changed (give the effective date only if a note states it)\n" +
  "- bounded: the claim still holds, but only within narrower conditions (give them as `within`)\n" +
  "- support-withdrawn: the evidence it rested on is gone (retracted, invalid) without showing the claim false\n" +
  "- unresolved: incompatible claims under comparable conditions, with evidence on both sides\n" +
  "- no-relation: the newer note does not change this claim\n" +
  "- insufficient: the notes do not let you decide\n" +
  "Lack of evidence is `insufficient`, never `unresolved`. `because` says what follows now, under which conditions, on what evidence — " +
  "not who erred. Reply with JSON only: " +
  '{"compatible_if":"…","distinguishing_observation":"…","outcome":"<one of the seven>","within":"…","effective":"YYYY[-MM[-DD]]",' +
  '"because":"<one sentence>","quotes_old":["<exact quote>"],"quotes_new":["<exact quote>"]}';

export function reviewPrompt(p: { claim: string; older: { title: string; text: string }; newer: { title: string; text: string }; oldFirst: boolean }): string {
  const a = [`NOTE [[${p.older.title}]] (the earlier note)`, clip(p.older.text, NOTE_CHARS)].join("\n");
  const b = [`NOTE [[${p.newer.title}]] (the later note)`, clip(p.newer.text, NOTE_CHARS)].join("\n");
  return [
    `The claim under review, from [[${p.older.title}]]: "${p.claim}"`,
    `Question: how, if at all, does [[${p.newer.title}]] change this claim?`,
    "",
    ...(p.oldFirst ? [a, "", b] : [b, "", a]),
  ].join("\n");
}

export function parseReview(text: string | undefined): ReviewVerdict | null {
  const j = json<Record<string, unknown>>(text);
  if (!j) return null;
  const o = OUTCOMES[String(j.outcome ?? "").trim().toLowerCase()];
  if (!o) return null;
  const s = (k: string) => (typeof j[k] === "string" && (j[k] as string).trim() ? (j[k] as string).trim().slice(0, 600) : undefined);
  const list = (k: string) => (Array.isArray(j[k]) ? (j[k] as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 600)).slice(0, 4) : []);
  const eff = s("effective");
  return {
    ...o,
    ...(o.verdict === "bounds" && s("within") ? { within: s("within") } : {}),
    ...(o.kindOf === "world-change" && eff && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(eff) ? { effective: eff } : {}),
    ...(s("because") ? { because: s("because") } : {}),
    quotesOld: list("quotes_old"),
    quotesNew: list("quotes_new"),
  };
}

// ------------------------------------------------------------------ verify

export const VERIFY_SYSTEM =
  "You check a knowledge-base decision against the ORIGINAL SOURCES, not against anyone's summary. You get passages retrieved " +
  "from the source behind each note. Confirm only if the passages themselves show BOTH that the earlier source says what the claim " +
  "says (the note did not misread it) AND that the later source establishes the decision's reason. If a passage contradicts either, " +
  'answer refuted. If the passages are not enough to tell, answer abstain. Reply with JSON only: {"result":"confirmed"|"refuted"|"abstain","reason":"<one sentence>"}';

export type VerifyPacket = {
  claim: string;
  decision: string;
  older: { title: string; passages: Array<{ locator: string; text: string }> };
  newer: { title: string; passages: Array<{ locator: string; text: string }> };
};

export function verifyPrompt(p: VerifyPacket): string {
  const show = (side: VerifyPacket["older"], label: string) => [
    `${label} SOURCE (behind [[${side.title}]]):`,
    ...(side.passages.length ? side.passages.map((x) => `[${x.locator}]\n${x.text}`) : ["(no passages could be retrieved)"]),
  ];
  return [`CLAIM (from [[${p.older.title}]]): "${p.claim}"`, `DECISION: ${p.decision}`, "", ...show(p.older, "EARLIER"), "", ...show(p.newer, "LATER")].join("\n");
}

export function parseVerify(text: string | undefined): { result: "confirmed" | "refuted" | "abstain"; reason: string } | null {
  const j = json<{ result?: unknown; reason?: unknown }>(text);
  const r = String(j?.result ?? "");
  if (r !== "confirmed" && r !== "refuted" && r !== "abstain") return null;
  return { result: r, reason: String(j?.reason ?? "").slice(0, 400) };
}

// ---------------------------------------------------------------- escalate

export const ESCALATE_SYSTEM =
  REVIEW_SYSTEM.replace("Judge only from the two notes given.", "You get the two notes AND the full original sources behind them; judge from the sources, and treat the notes as summaries that may be wrong.") +
  ' Add "grounded": true only if you checked the outcome against the source text itself.';

export function escalatePrompt(p: { claim: string; older: { title: string; text: string; source: string }; newer: { title: string; text: string; source: string } }): string {
  return [
    `The claim under review, from [[${p.older.title}]]: "${p.claim}"`,
    `Question: how, if at all, does [[${p.newer.title}]] change this claim?`,
    "",
    `NOTE [[${p.older.title}]]`,
    clip(p.older.text, 12_000),
    `SOURCE behind [[${p.older.title}]]:`,
    clip(p.older.source || "(unreachable)", 60_000),
    "",
    `NOTE [[${p.newer.title}]]`,
    clip(p.newer.text, 12_000),
    `SOURCE behind [[${p.newer.title}]]:`,
    clip(p.newer.source || "(unreachable)", 60_000),
  ].join("\n");
}

export function parseEscalate(text: string | undefined): (ReviewVerdict & { grounded: boolean }) | null {
  const v = parseReview(text);
  if (!v) return null;
  const j = json<{ grounded?: unknown }>(text);
  return { ...v, grounded: j?.grounded === true };
}

// ----------------------------------------------------------------- wording

export const WORDING_SYSTEM =
  "You already judged this case and committed your verdict. Now you see the proposer's rationale for the first time. Say whether " +
  "it would have changed your outcome, then write the final `because`: one sentence, what follows now, under which conditions, on " +
  "what evidence, without saying who erred. Use ONLY the confirmed conclusions given; add no new fact. Reply with JSON only: " +
  '{"would_flip":true|false,"because":"<one sentence>"}';

export function wordingPrompt(p: { decision: string; confirmed: string; draft: string; rationale: string }): string {
  return [`DECISION: ${p.decision}`, `CONFIRMED CONCLUSIONS: ${p.confirmed}`, `YOUR DRAFT because: ${p.draft || "(none)"}`, `PROPOSER'S RATIONALE: ${p.rationale || "(none)"}`].join("\n");
}

export function parseWording(text: string | undefined): { flip: boolean; because: string } | null {
  const j = json<{ would_flip?: unknown; because?: unknown }>(text);
  if (!j || typeof j.because !== "string" || !j.because.trim()) return null;
  return { flip: j.would_flip === true, because: j.because.trim().slice(0, 400) };
}

export const WORDING_CHECK_SYSTEM =
  'Does SENTENCE assert any fact that CONFIRMED does not contain? Paraphrase is fine; a new number, entity, cause or condition is not. Reply with JSON only: {"adds":true|false}';

export const wordingCheckPrompt = (sentence: string, confirmed: string) => `CONFIRMED: ${confirmed}\nSENTENCE: ${sentence}`;

export function parseWordingCheck(text: string | undefined): boolean | null {
  const j = json<{ adds?: unknown }>(text);
  return typeof j?.adds === "boolean" ? j.adds : null;
}

/** "correction: …" style one-liner of a decision, for prompts. */
export function describeDecision(d: { relation: string; kindOf?: string; within?: string; effective?: string; because?: string }): string {
  const name =
    d.relation === "supersedes" ? (d.kindOf === "world-change" ? "world-change" : "correction") : d.relation === "bounds" ? "bounded" : d.relation === "contests" ? "unresolved" : "support-withdrawn";
  return [name, d.within ? `within: ${d.within}` : "", d.effective ? `effective ${d.effective}` : "", d.because ? `because: ${d.because}` : ""].filter(Boolean).join("; ");
}
