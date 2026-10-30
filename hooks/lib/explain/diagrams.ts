/**
 * The revision explainer (`/vault explain`): five pages, each a diagram and a
 * few lines of text. The diagrams are SVG built here, drawn as `Svg` on the
 * remote surfaces; the terminal draws `Image`, so `commonplace explain-render`
 * rasterizes the same markup into `assets/explain/<id>.png` (committed). The
 * last page is this vault's own numbers, drawn live: SVG on the remote
 * surfaces, text bars in the terminal.
 *
 * Every drawing carries its own background so it reads on a light or a dark
 * theme. Example notes are invented.
 */

export type ExplainPage = {
  id: string;
  title: string;
  /** Markdown under the picture. */
  body: string;
  /** What the picture says, for a surface or reader that cannot show it. */
  alt: string;
  /** Static pages only; the live page is drawn from `LiveCounts`. */
  svg?: () => string;
  /** The SVG's size, so the terminal can size its Image box. */
  w: number;
  h: number;
};

export type LiveCounts = {
  mode: string;
  paused: boolean;
  /** Proposals by state (accepted, pending, rejected, …). */
  counts: Record<string, number>;
  /** Summaries to recheck. */
  stale: number;
};

const C = {
  bg: "#f7f6f2",
  card: "#ffffff",
  line: "#d6d3ca",
  ink: "#22252b",
  muted: "#6b6f78",
  accent: "#1f7a8c",
  accentSoft: "#dcefF2",
  ok: "#2e7d4f",
  okSoft: "#e1f1e6",
  warn: "#a8611c",
  warnSoft: "#f6e8d9",
  model: "#5b4fa8",
  modelSoft: "#e9e6f7",
};
const FONT = `font-family="-apple-system, 'Segoe UI', system-ui, sans-serif"`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const frame = (w: number, h: number, inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ${FONT}>` +
  `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
  `<path d="M0 0L10 5L0 10z" fill="${C.muted}"/></marker></defs>` +
  `<rect width="${w}" height="${h}" rx="12" fill="${C.bg}"/>${inner}</svg>`;

const text = (x: number, y: number, s: string, o: { size?: number; fill?: string; weight?: number; anchor?: string } = {}) =>
  `<text x="${x}" y="${y}" font-size="${o.size ?? 13}" fill="${o.fill ?? C.ink}"${o.weight ? ` font-weight="${o.weight}"` : ""}${o.anchor ? ` text-anchor="${o.anchor}"` : ""}>${esc(s)}</text>`;

const box = (x: number, y: number, w: number, h: number, fill: string, stroke: string, lines: string[], sub?: string) => {
  const cx = x + w / 2;
  const top = y + h / 2 - ((lines.length - 1) * 16) / 2 - (sub ? 7 : 0) + 5;
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>` +
    lines.map((l, i) => text(cx, top + i * 16, l, { weight: 600, anchor: "middle" })).join("") +
    (sub ? text(cx, top + lines.length * 16 - 1, sub, { size: 11, fill: C.muted, anchor: "middle" }) : "")
  );
};

const arrow = (x1: number, y1: number, x2: number, y2: number, dashed = false) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C.muted}" stroke-width="1.5"${dashed ? ` stroke-dasharray="4 4"` : ""} marker-end="url(#a)"/>`;

/** Page 1: the four things revision keeps apart. */
const layersSvg = () => {
  const w = 760, h = 300;
  const cols = [
    { x: 24, t: ["Artifact"], s: "the captured source", d: ["never rewritten"], f: C.card, k: C.line },
    { x: 208, t: ["Extract"], s: "a source note", d: ["an LLM's reading", "of the artifact"], f: C.card, k: C.line },
    { x: 392, t: ["Decision"], s: "the ledger", d: ["how one claim relates", "to a newer note's"], f: C.accentSoft, k: C.accent },
    { x: 576, t: ["Summary"], s: "concepts and MOCs", d: ["rechecked when a", "claim they cite moves"], f: C.card, k: C.line },
  ];
  let g = text(24, 38, "Four things stay apart", { size: 17, weight: 700 });
  g += text(24, 60, "Revision only ever writes a decision. Sources are evidence; summaries get a receipt.", { fill: C.muted });
  for (const c of cols) {
    g += box(c.x, 92, 160, 74, c.f, c.k, c.t, c.s);
    c.d.forEach((l, i) => (g += text(c.x + 80, 196 + i * 17, l, { size: 12, fill: C.muted, anchor: "middle" })));
  }
  g += arrow(186, 129, 206, 129) + arrow(370, 129, 390, 129) + arrow(554, 129, 574, 129);
  g += `<rect x="392" y="240" width="160" height="34" rx="8" fill="${C.okSoft}" stroke="${C.ok}"/>`;
  g += text(472, 262, "git commit + Undo", { size: 12, weight: 600, fill: C.ok, anchor: "middle" });
  g += arrow(472, 232, 472, 238);
  return frame(w, h, g);
};

/** Page 2: the chain from a note you add to an accepted edge. */
const chainSvg = () => {
  const w = 780, h = 330;
  let g = text(24, 38, "From a note you add to an accepted edge", { size: 17, weight: 700 });
  g += text(24, 60, "Nobody is asked. An unsure step gets one second look; still unsure, it waits.", { fill: C.muted });
  const y = 96, bw = 108, bh = 62, gap = 16;
  const steps: Array<[string[], string, string, string]> = [
    [["You add", "a note"], "an ingest, an edit", C.card, C.line],
    [["Job"], "after 45 s quiet", C.card, C.line],
    [["Detect"], "haiku · ≤12 notes", C.modelSoft, C.model],
    [["Review"], "sonnet · blind", C.modelSoft, C.model],
    [["Verify"], "against sources", C.modelSoft, C.model],
    [["Wording"], "no added facts", C.modelSoft, C.model],
  ];
  steps.forEach(([t, s, f, k], i) => {
    const x = 24 + i * (bw + gap);
    g += box(x, y, bw, bh, f, k, t, s);
    if (i) g += arrow(x - gap, y + bh / 2, x - 2, y + bh / 2);
  });
  // Accept, then the commit, under the last step.
  const lx = 24 + 5 * (bw + gap);
  g += arrow(lx + bw / 2, y + bh, lx + bw / 2, 194);
  g += box(lx - 14, 196, bw + 28, 52, C.okSoft, C.ok, ["Accept"], "edge on the newer note");
  g += arrow(lx + bw / 2, 248, lx + bw / 2, 264);
  g += box(lx - 14, 266, bw + 28, 48, C.okSoft, C.ok, ["git commit"], "Undo on the band");
  // One escalation, under Review.
  const rx = 24 + 3 * (bw + gap);
  g += arrow(rx + bw / 2, y + bh, rx + bw / 2, 194, true);
  g += box(rx - 16, 196, bw + 32, 48, C.warnSoft, C.warn, ["unsure → opus"], "one escalation");
  g += arrow(rx + bw / 2, 244, rx + bw / 2, 272, true);
  g += text(rx + bw / 2, 290, "still unsure → pending", { size: 12, fill: C.warn, anchor: "middle" });
  g += text(24, 216, "Nothing changed? Most jobs", { size: 12, fill: C.muted });
  g += text(24, 232, "end at Detect, at haiku cost.", { size: 12, fill: C.muted });
  return frame(w, h, g);
};

/** Page 3: claim-scoped edges live on the newer note. */
const edgeSvg = () => {
  const w = 760, h = 342;
  let g = text(24, 38, "The edge lives on the newer note", { size: 17, weight: 700 });
  g += text(24, 60, "The older note is never edited. The edge names one claim in it and says why.", { fill: C.muted });
  // Older note.
  g += `<rect x="24" y="84" width="300" height="150" rx="10" fill="${C.card}" stroke="${C.line}" stroke-width="1.5"/>`;
  g += text(40, 110, "Acme Throughput Study (2024)", { weight: 700 });
  g += text(40, 136, "…the queue drained in", { fill: C.muted });
  g += `<rect x="36" y="144" width="276" height="24" rx="4" fill="${C.warnSoft}"/>`;
  g += text(42, 161, "a median of 40 minutes per batch", { fill: C.ink });
  g += text(40, 190, "…after the window was widened.", { fill: C.muted });
  g += text(40, 220, "unchanged · status shown when read", { size: 11, fill: C.warn });
  // Newer note.
  g += `<rect x="436" y="84" width="300" height="190" rx="10" fill="${C.card}" stroke="${C.accent}" stroke-width="1.5"/>`;
  g += text(452, 110, "Acme Throughput Study (2026)", { weight: 700 });
  g += `<rect x="448" y="120" width="276" height="112" rx="6" fill="${C.accentSoft}"/>`;
  const fm = ["supersedes:", "  - note: \"[[…(2024)]]\"", "    claim: \"a median of 40…\"", "    kind: world-change", "    because: \"window moved\""];
  fm.forEach((l, i) => (g += `<text x="458" y="${140 + i * 19}" font-size="12" font-family="ui-monospace, Menlo, monospace" fill="${C.ink}">${esc(l)}</text>`));
  g += text(452, 258, "accepted · committed · undoable", { size: 11, fill: C.ok });
  g += arrow(434, 160, 326, 156);
  // Relations legend.
  const rel: Array<[string, string]> = [
    ["supersedes", "correction, or the world changed"],
    ["bounds", "true only within a scope"],
    ["contests", "a newer note disagrees"],
    ["withdraws_support", "the evidence went away"],
  ];
  rel.forEach(([k, d], i) => {
    const x = 24 + (i % 2) * 370, yy = 304 + Math.floor(i / 2) * 22;
    g += text(x, yy, k, { size: 12, weight: 700, fill: C.accent });
    g += text(x + 128, yy, d, { size: 12, fill: C.muted });
  });
  return frame(w, h, g);
};

/** Page 4: git is the safety net. */
const safetySvg = () => {
  const w = 760, h = 318;
  let g = text(24, 38, "Git is the safety net", { size: 17, weight: 700 });
  g += text(24, 60, "Every accept is its own commit. Your uncommitted edits are never swept in.", { fill: C.muted });
  const y = 130;
  g += `<line x1="40" y1="${y}" x2="720" y2="${y}" stroke="${C.line}" stroke-width="3"/>`;
  const dots: Array<[number, string, string, string]> = [
    [90, C.muted, "your commit", ""],
    [230, C.accent, "ingest", "unit of work"],
    [370, C.ok, "accept", "Revision-Event"],
    [510, C.accent, "recheck", "summary receipt"],
    [650, C.warn, "Undo", "compensating commit"],
  ];
  for (const [x, col, a, b] of dots) {
    g += `<circle cx="${x}" cy="${y}" r="9" fill="${col}"/>`;
    g += text(x, y - 22, a, { weight: 600, anchor: "middle" });
    if (b) g += text(x, y + 30, b, { size: 11, fill: C.muted, anchor: "middle" });
  }
  g += `<path d="M650 ${y + 44} C 610 ${y + 96}, 420 ${y + 96}, 378 ${y + 46}" fill="none" stroke="${C.warn}" stroke-width="1.5" stroke-dasharray="4 4" marker-end="url(#a)"/>`;
  g += text(510, y + 112, "reverses exactly that accept", { size: 12, fill: C.warn, anchor: "middle" });
  g += `<rect x="24" y="262" width="712" height="40" rx="8" fill="${C.card}" stroke="${C.line}"/>`;
  g += text(40, 287, "Newer note has edits you have not committed?  The accept waits, and lands after your next commit.", { size: 12 });
  return frame(w, h, g);
};

/** Page 5, remote surfaces: this vault's proposals by state. */
export const liveSvg = (l: LiveCounts): string => {
  const rows = Object.entries(l.counts).sort((a, b) => b[1] - a[1]);
  const w = 640, h = 120 + Math.max(rows.length, 1) * 30 + (l.stale ? 30 : 0);
  let g = text(24, 38, "This vault now", { size: 17, weight: 700 });
  g += text(24, 60, `revision: ${l.mode}${l.paused ? " (paused)" : ""}`, { fill: C.muted });
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const col = (k: string) => (k === "accepted" ? C.ok : k === "pending" || k === "deferred" ? C.warn : k === "rejected" ? C.muted : C.accent);
  if (!rows.length) g += text(24, 100, "No proposals yet: nothing you added has changed an older note.", { fill: C.muted });
  rows.forEach(([k, n], i) => {
    const y = 84 + i * 30;
    g += text(140, y + 15, k, { anchor: "end" });
    g += `<rect x="152" y="${y}" width="${Math.max(4, (n / max) * 400)}" height="20" rx="4" fill="${col(k)}"/>`;
    g += text(160 + Math.max(4, (n / max) * 400), y + 15, String(n), { weight: 600 });
  });
  if (l.stale) g += text(24, h - 24, `${l.stale} summaries to recheck (lint: stale-derivation)`, { fill: C.warn });
  return frame(w, h, g);
};

/** Page 5, terminal: the same as text bars. */
export const liveBars = (l: LiveCounts): string => {
  const rows = Object.entries(l.counts).sort((a, b) => b[1] - a[1]);
  const head = `revision: ${l.mode}${l.paused ? " (paused)" : ""}`;
  if (!rows.length) return `${head}\n\nNo proposals yet: nothing you added has changed an older note.`;
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const pad = Math.max(...rows.map((r) => r[0].length));
  const lines = rows.map(([k, n]) => `${k.padStart(pad)} ${"█".repeat(Math.max(1, Math.round((n / max) * 30)))} ${n}`);
  return [head, "", "```", ...lines, "```", ...(l.stale ? ["", `${l.stale} summaries to recheck (lint: stale-derivation).`] : [])].join("\n");
};

export const EXPLAIN_PAGES: ExplainPage[] = [
  {
    id: "layers",
    title: "What revision does",
    svg: layersSvg,
    w: 760,
    h: 300,
    alt: "Artifact, extract, decision and summary kept apart; revision writes only decisions, each a git commit with Undo.",
    body:
      "When a note you add changes what an older note claims, commonplace records **how the two claims relate** — and nothing else. " +
      "Sources are never rewritten. Summaries (concepts, MOCs) that cite the older note are flagged for a recheck.",
  },
  {
    id: "chain",
    title: "How a change is checked",
    svg: chainSvg,
    w: 780,
    h: 330,
    alt: "You add a note, a job runs after 45 s quiet, haiku detects, sonnet reviews blind, verifies against sources, checks wording, then accept and git commit; unsure steps escalate once to opus, else pending.",
    body:
      "Each step is a small model call with a narrow job. The reviewer does not see the proposer's reasoning; the verifier checks quotes " +
      "against passages commonplace retrieved from the sources itself; the wording check rejects added facts. Most jobs stop at Detect.",
  },
  {
    id: "edge",
    title: "What gets written",
    svg: edgeSvg,
    w: 760,
    h: 342,
    alt: "An edge in the newer note's frontmatter names one exact claim in the older note, with a kind and a reason; the older note is unchanged.",
    body:
      "One edge in the **newer** note's frontmatter: which note, the exact claim, the kind, and why. Reading the older note shows its status first " +
      "(\"superseded …\", \"bounded …\") — age alone never demotes anything.",
  },
  {
    id: "safety",
    title: "Why it is safe to leave on",
    svg: safetySvg,
    w: 760,
    h: 318,
    alt: "A git timeline: your commit, an ingest unit, an accept commit, a summary recheck, and Undo as a compensating commit reversing the accept.",
    body:
      "Every accept is a commit with a `Revision-Event:` trailer; **Undo** on the band (or `/vault revise undo last`) reverts exactly that one. " +
      "Turn it off in the plugin's settings (`vaultRevision`), or set `\"revision\": \"manual\"` in `.wiki/config.json` to keep proposals without writes.",
  },
  {
    id: "live",
    title: "This vault",
    w: 640,
    h: 240,
    alt: "This vault's revision proposals by state.",
    body: "`/vault revise` for the same numbers · `/vault revise log` for each decision · `/vault activity` for what happened this session.",
  },
];
