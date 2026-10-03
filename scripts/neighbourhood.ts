#!/usr/bin/env tsx
/** `commonplace neighbourhood` — CLI twin of vault_neighbourhood; see graph-cli.ts. */
import { run } from "./graph-cli.js";
await run("neighbourhood", process.argv.slice(2));
