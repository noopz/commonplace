#!/usr/bin/env node
/**
 * npm run explain:render — rasterize the explainer's diagrams for the terminal.
 *
 * The terminal's `Image` takes PNG, not SVG, and the module has no renderer,
 * so the same markup the remote surfaces draw (hooks/lib/explain/diagrams.ts)
 * is screenshotted here with headless Chrome at 2× into assets/explain/<id>.png.
 * Run after changing a diagram and commit the PNGs. Dev-only; never at runtime.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXPLAIN_PAGES } from "../hooks/lib/explain/diagrams.ts";

const CHROME = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!CHROME) {
  console.error("No Chrome found; set CHROME to its binary.");
  process.exit(1);
}

const out = resolve(import.meta.dirname, "..", "assets", "explain");
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "cp-explain-"));
try {
  for (const p of EXPLAIN_PAGES) {
    if (!p.svg) continue;
    const src = join(tmp, `${p.id}.svg`);
    writeFileSync(src, p.svg());
    execFileSync(CHROME, [
      "--headless", "--disable-gpu", "--hide-scrollbars",
      "--default-background-color=00000000", "--force-device-scale-factor=2",
      `--window-size=${p.w},${p.h}`, `--screenshot=${join(out, `${p.id}.png`)}`, `file://${src}`,
    ], { stdio: "ignore", timeout: 60_000 });
    console.log(`assets/explain/${p.id}.png`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
