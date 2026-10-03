#!/usr/bin/env tsx
/**
 * commonplace synthetic --scale N --out <dir> [--seed S] [--json]
 *
 * Writes a deterministic synthetic vault (invented lexicon text, Zipf-skewed
 * link degree, private domains, excluded scaffolding) at N× the ~840-note
 * base. The corpus `eval:scale` benchmarks against. See scripts/lib/synthetic.ts.
 */
import { parseArgs } from "node:util";
import { existsSync, readdirSync } from "fs";
import { resolve } from "path";
import { generateSynthetic } from "./lib/synthetic.js";

const { values } = parseArgs({
  options: {
    scale: { type: "string", default: "1" },
    out: { type: "string" },
    seed: { type: "string", default: "1" },
    json: { type: "boolean", default: false },
  },
});

const scale = Number(values.scale);
const seed = Number(values.seed);
if (!Number.isFinite(scale) || scale <= 0) {
  console.error("error: --scale must be a positive number");
  process.exit(1);
}
if (!Number.isInteger(seed)) {
  console.error("error: --seed must be an integer");
  process.exit(1);
}
if (!values.out) {
  console.error("error: --out <dir> is required");
  process.exit(1);
}
const callerCwd = process.env.COMMONPLACE_CALLER_CWD || process.cwd();
const out = resolve(callerCwd, values.out);
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error(`error: ${out} exists and is not empty — refusing to write into it`);
  process.exit(1);
}

const res = generateSynthetic({ scale, out, seed });
if (values.json) {
  console.log(JSON.stringify(res, null, 2));
} else {
  const c = res.counts;
  console.log(
    `Wrote ${c.files} files to ${out} in ${res.ms} ms (scale ${scale}, seed ${seed}): ` +
      `${c.sources} sources, ${c.concepts} concepts (${c.stubs} stubs, ${c.aliasedConcepts} aliased), ` +
      `${c.mocs} MOCs, ${c.journal} journal, ${c.excluded} excluded; ` +
      `${c.bodyLinks} body links; hub in-degree ${res.maxConceptInDegree}; hash ${res.hash.slice(0, 12)}`,
  );
}
