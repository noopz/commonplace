/**
 * CLI twins (`commonplace search|note|links|path|neighbourhood`) over an
 * invented vault: same formatters as the tools, private domains sealed unless
 * the person passes --open.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dirname!, "..");
const cli = (args: string[]) => {
  try {
    return { out: execFileSync(process.execPath, [join(ROOT, "bin", "commonplace"), ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
};

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), "graph-cli-vault-"));
  mkdirSync(join(root, ".wiki"), { recursive: true });
  writeFileSync(join(root, ".wiki", "config.json"), JSON.stringify({ structure: { sources: "Research", concepts: "Concepts", mocs: "Maps" } }));
  writeFileSync(join(root, ".wiki", "domains.json"), JSON.stringify({
    domains: { alpha: { path: "Research/Alpha", scope: "public" }, gamma: { path: "Research/Gamma", scope: "private" } },
  }));
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("Research/Alpha/Acme Report.md", "---\nconcepts:\n  - \"[[Delta Idea]]\"\n---\n# Acme Report\n\n## Findings\n\nStaged calibration, see [[Delta Idea]] and [[Gamma Secret]].\n");
  put("Concepts/Delta Idea.md", "# Delta Idea\n\nA drift budget.\n");
  const index = () => execFileSync(process.execPath, [join(ROOT, "bin", "commonplace"), "index", "--vault", root], { stdio: "ignore" });
  // The first v2 index keeps any concept a private note already cites private
  // (migration, plan §4.1); citing it afterwards leaves it public.
  index();
  put("Research/Gamma/Gamma Secret.md", "# Gamma Secret\n\nBuilds on [[Delta Idea]].\n");
  index();
  return root;
}

test("search/note/links answer with the tool formatters; sealed notes stay absent", () => {
  const root = vault();
  try {
    const s = cli(["search", "--vault", root, "--query", "acme report"]);
    assert.equal(s.code, 0, s.out);
    assert.match(s.out, /1\. Acme Report/);
    assert.match(s.out, /Pointers only/);
    assert.equal(cli(["note", "--vault", root, "--ref", "Gamma Secret"]).code, 1);
    const n = cli(["note", "--vault", root, "--ref", "Acme Report"]);
    assert.ok(!n.out.includes("Gamma Secret"), n.out);
    const l = cli(["links", "--vault", root, "--ref", "Acme Report", "--direction", "out"]);
    // Both the frontmatter relation and the body link, each with its own line.
    assert.match(l.out, /\[\[Delta Idea\]\] concept — pointer text \(unread\): "concepts: \[\[Delta Idea\]\]"/);
    assert.match(l.out, /\[\[Delta Idea\]\] body — ## Findings: pointer text/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--open admits a private domain; a public or unknown one is refused", () => {
  const root = vault();
  try {
    const n = cli(["note", "--vault", root, "--ref", "Gamma Secret", "--open", "gamma"]);
    assert.equal(n.code, 0, n.out);
    assert.match(n.out, /private domain, open in this session/);
    assert.equal(cli(["search", "--vault", root, "--query", "x", "--open", "alpha"]).code, 1);
    const j = JSON.parse(cli(["links", "--vault", root, "--ref", "Delta Idea", "--direction", "in", "--json", "--open", "gamma"]).out);
    assert.ok(j.links.some((x: { from: { title: string } }) => x.from.title === "Gamma Secret"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
