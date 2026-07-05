/**
 * Pure scoring for the Connect eval. Two layers:
 *   - Substrate (deterministic, zero-token): does the PPR pool CONTAIN the
 *     notes a correct answer must reach, and how high does it rank the first?
 *   - Agentic (from triage transcripts): did the model's picks match the gold
 *     targets, and did it correctly abstain on near-miss negatives?
 * Every aggregate carries a bootstrap confidence interval so a 24/10-item gold
 * set reports honest uncertainty instead of a false-precision point estimate.
 */

export interface ConnectGold {
  id: string;
  question: string;
  seed_notes?: string[];
  /** Notes a correct answer must surface. Empty for negatives. */
  expected_notes: string[];
  type: string; // connect-explicit | connect-latent | connect-bridge | negative
  subtype?: string;
  relationship?: string;
  hops?: number;
}

/** One agentic triage transcript: what the model picked, or that it abstained. */
export interface TriageResult {
  id: string;
  picks: string[];
  abstain: boolean;
  reframe_query?: string | null;
}

export const f1 = (precision: number, recall: number): number =>
  precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

const intersect = (a: string[], b: Set<string>): number => a.filter((x) => b.has(x)).length;

/** Non-seed targets: the notes Connect must REACH (the seed is where you start). */
export function targetsOf(g: ConnectGold): string[] {
  const seed = new Set(g.seed_notes ?? []);
  return g.expected_notes.filter((e) => !seed.has(e));
}

export interface PoolMetrics {
  /** Fraction of targets present anywhere in the pool (the triage ceiling). */
  recall: number;
  /** Reciprocal rank of the first target in the ordered pool (0 = absent). */
  mrr: number;
  baseRecall: number;
  basePrecision: number;
  baseF1: number;
}

/** Substrate metrics for one positive: pool recall/MRR + a top-k baseline. */
export function poolMetrics(targets: string[], orderedPool: string[], k: number): PoolMetrics {
  const tset = new Set(targets);
  if (tset.size === 0) return { recall: 1, mrr: 1, baseRecall: 1, basePrecision: 0, baseF1: 0 };
  const inPool = intersect(orderedPool, tset) > 0 ? orderedPool.filter((p) => tset.has(p)) : [];
  const firstIdx = orderedPool.findIndex((p) => tset.has(p));
  const top = orderedPool.slice(0, k);
  const baseRecall = intersect(top, tset) / tset.size;
  const basePrecision = top.length === 0 ? 0 : intersect(top, tset) / top.length;
  return {
    recall: inPool.length / tset.size,
    mrr: firstIdx === -1 ? 0 : 1 / (firstIdx + 1),
    baseRecall,
    basePrecision,
    baseF1: f1(basePrecision, baseRecall),
  };
}

export interface TriageMetrics {
  recall: number;
  precision: number;
  f1: number;
  abstained: boolean;
}

/** Agentic metrics for one positive: picks vs targets. Abstaining scores zero. */
export function triageMetrics(targets: string[], picks: string[], abstain: boolean): TriageMetrics {
  const tset = new Set(targets);
  if (abstain || picks.length === 0) return { recall: 0, precision: 0, f1: 0, abstained: true };
  const recall = tset.size === 0 ? 0 : intersect(picks, tset) / tset.size;
  const precision = intersect(picks, tset) / picks.length;
  return { recall, precision, f1: f1(precision, recall), abstained: false };
}

// --- Bootstrap confidence intervals (seeded → deterministic) ---

/** Mulberry32: tiny deterministic PRNG so CIs are reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export interface CI {
  mean: number;
  lo: number;
  hi: number;
  n: number;
}

/**
 * Percentile bootstrap CI for the mean of `values`. Resamples with replacement
 * `iterations` times; the CI is the [alpha/2, 1-alpha/2] quantiles of the
 * resample means. Deterministic given `seed`.
 */
export function bootstrapCI(
  values: number[],
  opts: { iterations?: number; seed?: number; alpha?: number } = {},
): CI {
  const { iterations = 2000, seed = 12345, alpha = 0.05 } = opts;
  const n = values.length;
  if (n === 0) return { mean: 0, lo: 0, hi: 0, n: 0 };
  if (n === 1) return { mean: values[0], lo: values[0], hi: values[0], n: 1 };
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += values[(rand() * n) | 0];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const q = (p: number) => means[Math.min(n === 0 ? 0 : iterations - 1, Math.max(0, Math.round(p * (iterations - 1))))];
  return { mean: mean(values), lo: q(alpha / 2), hi: q(1 - alpha / 2), n };
}
