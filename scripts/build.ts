#!/usr/bin/env tsx
/**
 * Bundle every CLI entry point into `dist/` so `bin/commonplace` can run a
 * command with plain `node` instead of a tsx cold start (~220ms → ~40ms).
 *
 *   npm run build          (also run by `commonplace session-check` when dist is stale)
 *
 * One ESM file per command (`dist/<script path>.mjs`), Node platform, deps
 * bundled except the heavy optional ones. The scripts locate the plugin root
 * through `import.meta.dirname` / `import.meta.url`, which in a flat bundle
 * would all point at `dist/`; the `relocate` plugin rewrites each occurrence to
 * the ORIGINAL source file's location, so `resolve(import.meta.dirname, "..")`
 * means the same thing bundled as it does under tsx.
 *
 * `dist/stamp.json` records the newest source mtime at build time; the bin
 * falls back to tsx whenever a source is newer, so a stale bundle never runs.
 */
import { build, type Plugin } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { newestSourceMtime } from "./lib/build-stamp.js";

const root = join(import.meta.dirname!, "..");
// `--out <dir>` builds elsewhere (tests); the default swaps into dist/ in one
// rename so a concurrently running `commonplace` never sees a half-built dist.
const outArg = process.argv.indexOf("--out");
const finalDir = outArg !== -1 ? process.argv[outArg + 1] : join(root, "dist");
const dist = `${finalDir}.next-${process.pid}`;

/** Command → entry, parsed from bin/commonplace's SCRIPTS table (single source of truth). */
function entries(): string[] {
  const bin = readFileSync(join(root, "bin", "commonplace"), "utf-8");
  const table = bin.slice(bin.indexOf("const SCRIPTS = {"), bin.indexOf("};", bin.indexOf("const SCRIPTS = {")));
  return [...table.matchAll(/:\s*'([^']+\.ts)'/g)].map((m) => m[1]);
}

const relocate: Plugin = {
  name: "relocate-import-meta",
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, (args) => {
      const src = readFileSync(args.path, "utf-8");
      if (!src.includes("import.meta")) return { contents: src, loader: "ts" };
      const rel = relative(root, args.path);
      const relDir = dirname(rel);
      const contents = src
        .replace(/import\.meta\.dirname!?/g, `__cpPath(${JSON.stringify(relDir)})`)
        .replace(/import\.meta\.filename!?/g, `__cpPath(${JSON.stringify(rel)})`)
        .replace(/import\.meta\.url/g, `__cpUrl(${JSON.stringify(rel)})`);
      return { contents, loader: "ts" };
    });
  },
};

const banner = [
  `import { fileURLToPath as __cpF, pathToFileURL as __cpP } from "node:url";`,
  `import { join as __cpJ, dirname as __cpD } from "node:path";`,
  `import { createRequire as __cpR } from "node:module";`,
  `const require = __cpR(import.meta.url);`,
  `const __cpRoot = __cpJ(__cpD(__cpF(import.meta.url)), ${"__DEPTH__"});`,
  `const __cpPath = (rel) => __cpJ(__cpRoot, rel);`,
  `const __cpUrl = (rel) => __cpP(__cpJ(__cpRoot, rel)).href;`,
].join("\n");

const t0 = Date.now();
const stampBefore = newestSourceMtime(root);
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const files = entries().filter((e) => existsSync(join(root, e)));
for (const entry of files) {
  const out = join(dist, entry.replace(/\.ts$/, ".mjs"));
  // Depth from the output file back to the plugin root, e.g. dist/scripts/x.mjs → "../.."
  const depth = relative(dirname(out), root).split(/[\\/]/).map(() => "..");
  await build({
    entryPoints: [join(root, entry)],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    logLevel: "warning",
    external: ["pdfjs-dist", "pdfjs-dist/*", "esbuild"],
    plugins: [relocate],
    banner: { js: banner.replace(`${"__DEPTH__"}`, depth.map((d) => JSON.stringify(d)).join(", ")) },
  });
}
writeFileSync(join(dist, "stamp.json"), JSON.stringify({ newestSourceMtime: stampBefore, builtAt: new Date().toISOString(), entries: files.length }) + "\n");
const old = `${finalDir}.old-${process.pid}`;
if (existsSync(finalDir)) renameSync(finalDir, old);
renameSync(dist, finalDir);
rmSync(old, { recursive: true, force: true });
console.log(`built ${files.length} entries into dist/ in ${Date.now() - t0}ms`);
