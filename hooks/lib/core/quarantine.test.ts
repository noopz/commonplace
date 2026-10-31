import { test } from "node:test";
import assert from "node:assert/strict";
import { quarantinedFolders, domainIdFor, treeRows, type QuarantinedFolder } from "./quarantine.ts";

const opts = {
  domains: { alpha: { path: "Research/Alpha", scope: "public" } },
  knownLoose: new Set(["Inbox"]),
  structureDirs: ["Concepts", "Maps"],
};

test("quarantinedFolders groups notes in new top folders outside every domain", () => {
  const rels = [
    "Research/Alpha/Kestrel Study.md", // in a domain
    "Inbox/Loose Thought.md", // known at the first index
    "Concepts/Gamma Term.md", // structure folder
    "Acme Robot/README.md",
    "Acme Robot/docs/assembly.md",
    "Acme Robot/docs/wiring.md",
    "Marble Notes/one.md",
    "Top Level Note.md", // no folder: never quarantined
  ];
  assert.deepEqual(quarantinedFolders(rels, opts), [
    { folder: "Acme Robot", notes: 3, rels: ["Acme Robot/README.md", "Acme Robot/docs/assembly.md", "Acme Robot/docs/wiring.md"] },
    { folder: "Marble Notes", notes: 1, rels: ["Marble Notes/one.md"] },
  ]);
});

test("domainIdFor slugs the folder and never reuses an id", () => {
  assert.equal(domainIdFor({}, "Acme Robot"), "acme-robot");
  assert.equal(domainIdFor({ "acme-robot": { path: "x" } }, "Acme Robot"), "acme-robot-2");
  assert.equal(domainIdFor({}, "日本"), "folder");
});

const folders: QuarantinedFolder[] = [
  { folder: "Acme Robot", notes: 3, rels: ["Acme Robot/README.md", "Acme Robot/docs/Wiring.md", "Acme Robot/docs/deep/Servo.md"] },
  { folder: "Marble Notes", notes: 1, rels: ["Marble Notes/One.md"] },
];

test("a closed tree shows only the folders, with their note counts", () => {
  assert.deepEqual(
    treeRows(folders, new Set()).map((r) => [r.depth, r.name, r.notes]),
    [[0, "Acme Robot", 3], [0, "Marble Notes", 1]],
  );
});

test("expanding walks one level at a time, subfolders before notes", () => {
  const one = treeRows(folders, new Set(["Acme Robot"]));
  assert.deepEqual(one.map((r) => [r.depth, r.name, r.notes]), [[0, "Acme Robot", 3], [1, "docs", 2], [1, "README", null], [0, "Marble Notes", 1]]);
  const two = treeRows(folders, new Set(["Acme Robot", "Acme Robot/docs"]));
  assert.deepEqual(two.slice(1, 4).map((r) => [r.depth, r.name]), [[1, "docs"], [2, "deep"], [2, "Wiring"]]);
  assert.equal(two[2]!.path, "Acme Robot/docs/deep");
});
