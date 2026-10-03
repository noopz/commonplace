#!/usr/bin/env tsx
/** `commonplace note` — CLI twin of vault_note; see graph-cli.ts. */
import { run } from "./graph-cli.js";
await run("note", process.argv.slice(2));
