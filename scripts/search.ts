#!/usr/bin/env tsx
/** `commonplace search` — CLI twin of vault_search; see graph-cli.ts. */
import { run } from "./graph-cli.js";
await run("search", process.argv.slice(2));
