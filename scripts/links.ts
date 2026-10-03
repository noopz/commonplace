#!/usr/bin/env tsx
/** `commonplace links` — CLI twin of vault_links; see graph-cli.ts. */
import { run } from "./graph-cli.js";
await run("links", process.argv.slice(2));
