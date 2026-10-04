/**
 * An invented vault for the UI tests, served to the module from memory.
 *
 * The index is built with the module's own `buildIndex` / `serializeIndex`, so
 * the files the module reads are the shape `commonplace index` writes. The
 * hooks `serveVault` registers sit beneath the plugin and answer the nouns it
 * reaches outside itself: the registry CLI (`process.run`), and the vault's
 * files (`fs.read`, `fs.stat`). Nothing here names real vault content.
 */
import type { On } from "claude-code";
import { parseNote } from "../hooks/lib/index/parse.ts";
import { buildIndex, type IndexNote } from "../hooks/lib/index/model.ts";
import { serializeIndex } from "../hooks/lib/index/layout.ts";

export const VAULT = "/fixture/acme-vault";

const DOMAINS = {
  alpha: { path: "Research/Alpha", scope: "public" as const },
  gamma: { path: "Research/Gamma", scope: "private" as const },
};

export const NOTES: Record<string, string> = {
  "Research/Alpha/Kestrel Calibration Protocol.md":
    "---\nabstraction: staged kestrel sensor calibration with drift budgets\n---\n# Kestrel Calibration Protocol\n\nBuilds on [[Marble Queue Sharding]] and uses [[Drift Budget]].\n",
  "Research/Alpha/Marble Queue Sharding.md":
    "---\nabstraction: sharding marble queues by tenant to bound tail latency\n---\n# Marble Queue Sharding\n\nSee [[Drift Budget]].\n",
  "Concepts/Drift Budget.md": "---\nabstraction: an allowance for sensor drift before recalibration\n---\n# Drift Budget\n\nA bound on drift.\n",
  "Research/Gamma/Gamma Orchard Ledger.md": "---\nabstraction: orchard ledger reconciliation\n---\n# Gamma Orchard Ledger\n\nUses [[Drift Budget]].\n",
};

const STRUCTURE = { sources: "Research", concepts: "Concepts", mocs: "Maps" };

function files(): Map<string, string> {
  const notes: IndexNote[] = Object.entries(NOTES).map(([rel, text]) => ({
    rel,
    parsed: parseNote(rel, text, { structure: STRUCTURE, domainPaths: Object.values(DOMAINS).map((d) => d.path) }),
    mt: 1,
    sz: text.length,
    stub: false,
  }));
  const built = buildIndex(notes, { domains: DOMAINS, version: 1, builtAt: "fixture" });
  const out = new Map<string, string>();
  for (const [rel, text] of serializeIndex(built, { version: 1, builtAt: "fixture" })) out.set(`${VAULT}/.wiki/${rel}`, text);
  out.set(`${VAULT}/.wiki/domains.json`, JSON.stringify({ domains: DOMAINS }));
  out.set(`${VAULT}/.wiki/config.json`, JSON.stringify({ structure: STRUCTURE }));
  for (const [rel, text] of Object.entries(NOTES)) out.set(`${VAULT}/${rel}`, text);
  return out;
}

/** Answer the module's reads of the fixture vault, and its registry CLI call. */
/**
 * `registryDown` fails `commonplace vaults` (a fresh install before npm
 * install finishes). `hold` names a vault-relative file whose read waits until the returned
 * `release` is called: how a test looks at the module mid-call.
 */
export function serveVault(on: On, opts: { hold?: string; registryDown?: boolean } = {}): { release: () => void } {
  const fs = files();
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  on("process.run", async (_$, e) => {
    const argv = e.argv.join(" ");
    if (argv.includes(" vaults --json") && opts.registryDown) {
      return { value: { exitCode: 1, stdout: "", stderr: "Cannot find module tsx", isStdoutTruncated: false, isStderrTruncated: false } };
    }
    if (argv.includes(" vaults --json")) {
      return { value: { exitCode: 0, stdout: JSON.stringify({ matches: [{ path: VAULT, id: "acme", label: "Acme", aliases: [] }] }), stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
    }
    if (e.argv[e.argv.length - 1] === "vault-path") return { value: { exitCode: 0, stdout: `${VAULT}\n`, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
    if (e.argv[0] === "cat" && fs.has(e.argv[1] ?? "")) return { value: { exitCode: 0, stdout: fs.get(e.argv[1]!)!, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
    return { value: { exitCode: 1, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on("fs.read", async (_$, e) => {
    if (opts.hold && e.path === `${VAULT}/${opts.hold}`) await gate;
    const text = fs.get(e.path);
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: text };
  });
  on("fs.stat", async (_$, e) => {
    if (e.path === VAULT) return { value: { kind: "dir" as const, size: 0, mtimeMs: 1, isLink: false } };
    const text = fs.get(e.path);
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`);
    return { value: { kind: "file" as const, size: text.length, mtimeMs: 1, isLink: false } };
  });
  return { release };
}

/**
 * The engine beneath the plugin for what these tests do not inspect: the
 * session starts, toasts and the status line land nowhere, and the engine's
 * own drawing of a component is an empty column the plugin may wrap.
 */
export function engineFloor(on: On): void {
  on("session.start", async (_$, e) => ({ cwd: e.cwd }));
  on("session.cwd", async () => ({ value: "/fixture/project" }));
  on("session.id", async () => ({ value: "fixture-session-0001" }));
  on("session.version", async () => ({ value: { version: "2.1.288", base: "2.1.288" } }));
  on("session.repo", async () => ({ value: null }));
  on("tool.register", async (_$, e) => ({ value: { tool: `mcp__commonplace__${e.name}` } }));
  on("command.register", async (_$, e) => ({ value: { command: e.name } }));
  on("ui.toast", async () => ({ value: undefined }));
  on("ui.status", async () => ({ value: undefined }));
  on("ui.render", async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    // The spinner draws what it was handed, so a rewrite of its message shows.
    if (e.component === "Spinner") {
      const p = e.props as { word: string; message: string | null };
      return <Text>{p.message ?? p.word}</Text>;
    }
    return <Box flexDirection="column" />;
  });
}
