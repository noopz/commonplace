#!/usr/bin/env node
/** `commonplace note` — CLI twin of vault_note; see graph-cli.ts. */
import { run } from "./graph-cli.ts";
await run("note", process.argv.slice(2));
