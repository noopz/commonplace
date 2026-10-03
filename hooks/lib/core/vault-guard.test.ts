/**
 * The guard adapter over invented vaults: seal roots per open state (plan
 * §4.5 tests 21-25 through the adapter), the sealed-names leak guard, and
 * sanitise-on-the-way-down.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sealRootsFor, sanitizeWrite, leakVerdict, locate, namesFromLegacy, PRIVATE_VAULT_SHARD, type GuardVault } from "./vault-guard.ts";
import { checkSealedAccess, SEALED_DENY, PROTECTED_DENY } from "./seal.ts";
import { SEALED_LEAK_DENY, parseSealedNames, type SealedName } from "../guard.ts";

const V = "/vaults/acme";
const W = "/vaults/other";
const acme: GuardVault = {
  path: V,
  real: "/Volumes/disk/acme",
  domains: {
    alpha: { path: "02 - Research/Alpha", scope: "public" },
    gamma: { path: "04 - Explorations/Gamma", scope: "private", linkGroup: "g1" },
    delta: { path: "04 - Explorations/Delta", scope: "private", linkGroup: "g1" },
    epsilon: { path: "04 - Explorations/Epsilon", scope: "private" },
  },
};
const other: GuardVault = { path: W, domains: { beta: { path: "Beta", scope: "public" } } };
const VAULTS = [acme, other];
const GAMMA = `${V}/04 - Explorations/Gamma`;

const opens = (m: Record<string, string[]>) => (vp: string) => new Set(m[vp] ?? []);
const sealedAll = opens({});
const gammaOpen = opens({ [V]: ["g1"] });

const check = (tool: string, input: Record<string, unknown>, openOf = sealedAll, cwd = "/repos/app") =>
  checkSealedAccess(tool, input, sealRootsFor(VAULTS, openOf), cwd, "/home/u");

test("21 via adapter: sealed folder denied; opening its group allows it and its sibling", () => {
  assert.deepEqual(check("Read", { file_path: `${GAMMA}/Gamma Term.md` }), { deny: SEALED_DENY });
  assert.equal(check("Read", { file_path: `${GAMMA}/Gamma Term.md` }, gammaOpen), null);
  assert.equal(check("Read", { file_path: `${V}/04 - Explorations/Delta/Delta Idea.md` }, gammaOpen), null, "linkGroup");
  assert.deepEqual(
    check("Read", { file_path: `${V}/04 - Explorations/Epsilon/E.md` }, gammaOpen),
    { deny: SEALED_DENY },
    "another private domain stays sealed",
  );
  // the resolved spelling of the vault is sealed too
  assert.deepEqual(check("Read", { file_path: "/Volumes/disk/acme/04 - Explorations/Gamma/x.md" }), { deny: SEALED_DENY });
});

test("22 via adapter: root greps denied while anything is sealed; allowed once nothing is", () => {
  assert.deepEqual(check("Bash", { command: `grep -r x "${V}"` }), { deny: SEALED_DENY });
  const allOpen = opens({ [V]: ["g1", "epsilon"] });
  assert.equal(check("Bash", { command: `grep -r x "${V}"` }, allOpen), null, "Q9: nothing sealed");
  assert.deepEqual(check("Read", { file_path: `${V}/.wiki/sealed/names.json` }, allOpen), { deny: SEALED_DENY }, "sealed/ is never readable");
  // a vault with no private domains: root greppable, sealed/ still unreadable
  assert.equal(check("Bash", { command: `grep -rn x ${W}` }), null);
  assert.deepEqual(check("Read", { file_path: `${W}/.wiki/sealed/names.json` }), { deny: SEALED_DENY });
});

test("23/24 via adapter: unrelated repo untouched; skills writes denied in every vault", () => {
  assert.equal(check("Bash", { command: "grep -rn TODO src/" }), null);
  assert.deepEqual(check("Write", { file_path: `${W}/.wiki/skills/x/SKILL.md`, content: "x" }), { deny: PROTECTED_DENY });
});

test("locate picks the vault and the relative path; siblings are not inside", () => {
  assert.deepEqual(locate(VAULTS, `${V}/a/b.md`)?.rel, "a/b.md");
  assert.equal(locate(VAULTS, "/vaults/acme2/a.md"), null);
  assert.equal(locate(VAULTS, "/Volumes/disk/acme/a.md")?.vault.path, V);
});

// --- leak guard -------------------------------------------------------------

const NAMES: SealedName[] = [
  { t: "Gamma Calibration Ledger", al: ["GCL Ledger Notes"], shard: "g1", vault: V },
  { t: "Epsilon Drift Archive", shard: "epsilon", vault: V },
];

test("sealed title written into a repo: deny names nothing", () => {
  const v = leakVerdict("Write", { file_path: "/repos/app/x.ts", content: "// from the Gamma Calibration Ledger" }, VAULTS, NAMES, sealedAll, "/repos/app");
  assert.deepEqual(v, { deny: SEALED_LEAK_DENY });
  assert.doesNotMatch(v!.deny, /gamma/i);
  // alias also matches
  assert.deepEqual(
    leakVerdict("Edit", { file_path: "/repos/app/x.ts", new_string: "see GCL Ledger Notes" }, VAULTS, NAMES, sealedAll, "/repos/app"),
    { deny: SEALED_LEAK_DENY },
  );
});

test("open title written into a repo: today's deny, which names it", () => {
  const v = leakVerdict("Write", { file_path: "/repos/app/x.ts", content: "Gamma Calibration Ledger" }, VAULTS, NAMES, gammaOpen, "/repos/app");
  assert.match(v!.deny, /Gamma Calibration Ledger/);
  assert.match(v!.deny, /invented/);
});

test("in-vault: own shard passes; public target denies only links into a private group", () => {
  const gammaNote = `${GAMMA}/New.md`;
  assert.equal(leakVerdict("Write", { file_path: gammaNote, content: "[[Gamma Calibration Ledger]]" }, VAULTS, NAMES, gammaOpen, "/"), null);
  const pub = `${V}/02 - Research/Alpha/Alpha Report.md`;
  assert.equal(
    leakVerdict("Write", { file_path: pub, content: "the gamma calibration ledger phrase in prose" }, VAULTS, NAMES, gammaOpen, "/"),
    null,
    "phrase is not a link",
  );
  assert.ok(leakVerdict("Write", { file_path: pub, content: "see [[Gamma Calibration Ledger]]" }, VAULTS, NAMES, gammaOpen, "/"));
  // a gamma note linking into epsilon (another private group)
  assert.deepEqual(
    leakVerdict("Write", { file_path: gammaNote, content: "[[Epsilon Drift Archive]]" }, VAULTS, NAMES, gammaOpen, "/"),
    { deny: SEALED_LEAK_DENY },
  );
  // .wiki writes are commonplace's own
  assert.equal(leakVerdict("Write", { file_path: `${V}/.wiki/log.md`, content: "[[Epsilon Drift Archive]]" }, VAULTS, NAMES, sealedAll, "/"), null);
});

test("cross-vault: another vault's private title is checked in full (B13)", () => {
  assert.deepEqual(
    leakVerdict("Write", { file_path: `${W}/Beta/Note.md`, content: "Epsilon Drift Archive notes" }, VAULTS, NAMES, sealedAll, "/"),
    { deny: SEALED_LEAK_DENY },
  );
});

test("names.json parse and legacy fallback", () => {
  const parsed = parseSealedNames(JSON.stringify({ v: 2, names: [{ t: "Gamma Term", al: ["GT"], shard: "g1" }, { t: "" }] }), V);
  assert.deepEqual(parsed, [{ t: "Gamma Term", al: ["GT"], shard: "g1", vault: V }]);
  assert.deepEqual(parseSealedNames("not json"), []);
  const legacy = namesFromLegacy(
    [
      { title: "Gamma Term", scope: "private", domain: "gamma" },
      { name: "Loose Idea", scope: "private" },
      { title: "Alpha Report", scope: "public", domain: "alpha" },
    ],
    acme.domains,
    V,
  );
  assert.deepEqual(legacy, [
    { t: "Gamma Term", shard: "g1", vault: V },
    { t: "Loose Idea", shard: "loose", vault: V },
  ]);
});

// --- sanitise on the way down -----------------------------------------------

const LONG = `https://tracker.example.com/${"a".repeat(320)}`;

test("Write into a source note strips remote embeds in the body, never the frontmatter", () => {
  const content = `---\nsource: ${LONG}\n---\n# Alpha Report\n\n![pixel](https://beacon.example.com/p.png)\n\nok text\n`;
  const r = sanitizeWrite("Write", { file_path: `${V}/02 - Research/Alpha/Alpha Report.md`, content }, VAULTS, "/");
  assert.ok(r);
  assert.equal(r!.stripped.length, 1);
  assert.match(r!.patch.content, /\[image removed: pixel\]/);
  assert.ok(r!.patch.content.startsWith(`---\nsource: ${LONG}\n---\n`), "frontmatter untouched");
});

test("Edit new_string is sanitised; non-source and clean writes pass untouched", () => {
  const r = sanitizeWrite("Edit", { file_path: `${GAMMA}/G.md`, new_string: `see ${LONG}` }, VAULTS, "/");
  assert.equal(r!.stripped.length, 1);
  assert.doesNotMatch(r!.patch.new_string, /tracker/);
  assert.equal(sanitizeWrite("Write", { file_path: `${V}/.wiki/notes.md`, content: `![x](https://e.com/a.png)` }, VAULTS, "/"), null);
  assert.equal(sanitizeWrite("Write", { file_path: `${V}/Inbox/x.md`, content: `![x](https://e.com/a.png)` }, VAULTS, "/"), null, "not under a domain");
  assert.equal(sanitizeWrite("Write", { file_path: "/repos/app/README.md", content: `![x](https://e.com/a.png)` }, VAULTS, "/"), null);
  assert.equal(sanitizeWrite("Write", { file_path: `${V}/02 - Research/Alpha/A.md`, content: "clean" }, VAULTS, "/"), null);
  assert.equal(sanitizeWrite("Write", { file_path: `${V}/02 - Research/Alpha/A.md`, content: "![[local.png]]" }, VAULTS, "/"), null, "local embeds kept");
});

test("isPrivate vault: its titles cannot leave it, but link freely inside it", () => {
  const names: SealedName[] = [{ t: "Acme Quarterly Ledger", al: [], shard: PRIVATE_VAULT_SHARD, vault: V }];
  const repo = leakVerdict("Write", { file_path: "/repos/app/notes.md", content: "See Acme Quarterly Ledger." }, VAULTS, names, gammaOpen, "/repos/app");
  assert.ok(repo && "deny" in repo);
  const otherVault = leakVerdict("Write", { file_path: `${W}/Beta/B.md`, content: "[[Acme Quarterly Ledger]]" }, VAULTS, names, gammaOpen, "/");
  assert.ok(otherVault && "deny" in otherVault);
  const inside = leakVerdict(
    "Write",
    { file_path: `${V}/02 - Research/Alpha/A.md`, content: "Builds on [[Acme Quarterly Ledger]]." },
    VAULTS,
    names,
    sealedAll,
    "/",
  );
  assert.equal(inside, null);
});
