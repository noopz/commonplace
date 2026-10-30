import { test } from "node:test";
import assert from "node:assert/strict";
import { quarantinedFolders, domainIdFor } from "./quarantine.ts";

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
    { folder: "Acme Robot", notes: 3 },
    { folder: "Marble Notes", notes: 1 },
  ]);
});

test("domainIdFor slugs the folder and never reuses an id", () => {
  assert.equal(domainIdFor({}, "Acme Robot"), "acme-robot");
  assert.equal(domainIdFor({ "acme-robot": { path: "x" } }, "Acme Robot"), "acme-robot-2");
  assert.equal(domainIdFor({}, "日本"), "folder");
});
