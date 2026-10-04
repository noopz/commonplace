/**
 * Every `$.<noun>.<verb>(` the hooks module calls must exist in the newest
 * archived mods API snapshot.
 *
 * WHY: the module types `$` loosely in places, and `claude plugin validate`
 * does not resolve calls against the build's API — v1.67.2 shipped because
 * `$.session.turnCount()` was renamed `turns()` and nothing noticed until the
 * ambient pass had tripped its own circuit breaker. A rename in the next
 * snapshot fails this test instead.
 *
 * Nouns this plugin adds to `$` itself (declared in `types/index.d.ts`) are
 * checked against that contract rather than the engine's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function newestSnapshot(): string {
  const dir = join(root, "docs", "api-snapshots");
  const files = readdirSync(dir).filter((f) => /^claude-code\.[\d.]+\.d\.ts$/.test(f));
  const ver = (f: string) => f.replace(/^claude-code\.|\.d\.ts$/g, "").split(".").map(Number);
  files.sort((a, b) => {
    const va = ver(a), vb = ver(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      if ((va[i] ?? 0) !== (vb[i] ?? 0)) return (va[i] ?? 0) - (vb[i] ?? 0);
    }
    return 0;
  });
  return join(dir, files[files.length - 1]);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** Strip comments so prose mentioning `$.noun.verb()` is not checked. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("every $.noun.verb() the hooks module calls exists in the newest API snapshot", () => {
  const snapshot = readFileSync(newestSnapshot(), "utf8");
  const ownPath = join(root, "types", "index.d.ts");
  const own = existsSync(ownPath) ? readFileSync(ownPath, "utf8") : "";

  const missing: string[] = [];
  for (const file of walk(join(root, "hooks"))) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(/\$\.([a-z][a-zA-Z]*)\.([a-zA-Z]+)\(/g)) {
      const [, noun, verb] = m;
      const key = `'${noun}.${verb}'`;
      const declared =
        snapshot.includes(key) ||
        // A method with no event of its own (`$.ui.ask` rides `tool.call`):
        // every method's doc carries an example of the call.
        snapshot.includes(`$.${noun}.${verb}(`) ||
        // A plugin-added noun: its method must appear in our own contract.
        (own.includes(`${noun}:`) && new RegExp(`\\b${verb}\\s*[:(]`).test(own));
      if (!declared) missing.push(`${file.slice(root.length + 1)}: $.${noun}.${verb}()`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], "calls absent from the API snapshot");
});
