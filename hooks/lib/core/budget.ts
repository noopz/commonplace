/**
 * The daily budget for commonplace's own background model calls: the
 * connection pass, prime, revision jobs and read capture. What the person asks
 * for (ingest, queries, `/vault` commands, the subagents a skill dispatches)
 * never counts and is never stopped.
 *
 * The engine reports tokens, not dollars, so the price is computed here from
 * the API's list prices, read weekly from the pricing page. On a subscription
 * the figure is what the API would charge: a stand-in for the share of the
 * plan's limits the vault used.
 *
 * Pure: the module keeps the state in `$.store`, so a session that runs for
 * weeks, and every resume and reload, sees the same day. `spent` is the sum
 * of every session's own spend record.
 */

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export type Price = { input: number; output: number; read: number; write: number };
/** Model names as the pricing page writes them ("claude opus 5.5"), newest first within a family. */
export type PriceTable = ReadonlyArray<[string, Price]>;

/**
 * Fallback list prices (US dollars per million tokens, 2026-10), used until
 * the pricing page has been read once and whenever it cannot be.
 */
export const FALLBACK_PRICES: PriceTable = [
  ["claude fable 5.1", { input: 10, output: 50, read: 0.25, write: 12.5 }],
  ["claude opus 5.5", { input: 4, output: 20, read: 0.2, write: 5 }],
  ["claude sonnet 5.5", { input: 2, output: 10, read: 0.1, write: 2.5 }],
  ["claude haiku 5.5", { input: 0.1, output: 0.5, read: 0.01, write: 0.125 }],
];

/** Where the live table comes from: the docs' own Markdown rendering of the pricing page. */
export const PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";

const money = (cell: string): number | null => {
  const m = /\$([\d.]+)/.exec(cell);
  return m ? Number(m[1]) : null;
};

/**
 * The "Model pricing" table of the pricing page: model, base input, 5-minute
 * cache write, 1-hour cache write, cache hit, output. Rows for prompts over a
 * long-context threshold are skipped (background calls stay far below it);
 * anything that does not parse is skipped, and fewer than two rows is no table.
 */
export function parsePricing(md: string): PriceTable | null {
  const out: Array<[string, Price]> = [];
  for (const line of String(md ?? "").split("\n")) {
    if (!/^\|\s*Claude /.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 6 || /prompts over/i.test(cells[0])) continue;
    const name = cells[0].replace(/\(.*$/, "").trim().toLowerCase();
    const [input, write, , read, output] = cells.slice(1, 6).map(money);
    if (input === null || write === null || read === null || output === null || out.some(([n]) => n === name)) continue;
    out.push([name, { input, output, read, write }]);
  }
  return out.length >= 2 ? out : null;
}

/**
 * The price of `model`: an id (`claude-opus-5-5`) is matched to its row
 * exactly; an alias (`opus`, `haiku`) to its family's newest row. Unknown
 * models are priced as the newest Opus.
 */
export function priceFor(model: string, table: PriceTable): Price {
  const m = model.toLowerCase();
  const id = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(m);
  if (id) {
    const name = `claude ${id[1]} ${id[2]}${id[3] ? `.${id[3]}` : ""}`;
    const hit = table.find(([n]) => n === name);
    if (hit) return hit[1];
  }
  const family = /haiku|sonnet|opus|fable|mythos/.exec(m)?.[0] ?? "opus";
  return (table.find(([n]) => n.startsWith(`claude ${family} `)) ?? table.find(([n]) => n.startsWith("claude opus ")) ?? FALLBACK_PRICES[1])[1];
}

export const DEFAULT_DAILY_USD = 5;

/** What one call cost, in dollars. */
export function costOf(model: string, u: Usage, table: PriceTable = FALLBACK_PRICES): number {
  const p = priceFor(model, table);
  return (
    (u.input_tokens * p.input + u.output_tokens * p.output + (u.cache_read_input_tokens ?? 0) * p.read + (u.cache_creation_input_tokens ?? 0) * p.write) /
    1_000_000
  );
}

/** A local calendar day, `YYYY-MM-DD`; the budget resets at local midnight. */
export function dayOf(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export type BudgetState = {
  day: string;
  spent: number;
  /** Today's limit when raised from the notice; absent means the setting's. */
  limit?: number;
  /** The over-budget notice was raised today. */
  noticed?: boolean;
};

/** Today's state: yesterday's, or none, starts fresh. */
export function today(s: BudgetState | null | undefined, now: Date): BudgetState {
  const day = dayOf(now);
  return s && s.day === day ? s : { day, spent: 0 };
}

export const limitOf = (s: BudgetState, setting: number) => s.limit ?? setting;

/** Whether background work may start another call. Soft: a call already running finishes. */
export const canSpend = (s: BudgetState, setting: number) => s.spent < limitOf(s, setting);

/** Raise today's limit: double what it is now. */
export function raise(s: BudgetState, setting: number): BudgetState {
  return { ...s, limit: limitOf(s, setting) * 2, noticed: false };
}

export const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

/** The status line: `vault spend today: $1.20 of $5`. */
export function budgetLine(s: BudgetState, setting: number): string {
  return `vault spend today: ${usd(s.spent)} of ${usd(limitOf(s, setting))}${canSpend(s, setting) ? "" : " (background work paused until midnight)"}`;
}
