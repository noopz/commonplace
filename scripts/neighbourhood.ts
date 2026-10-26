#!/usr/bin/env node
/** `commonplace neighbourhood` — CLI twin of vault_neighbourhood; see graph-cli.ts. */
import { run } from "./graph-cli.ts";
await run("neighbourhood", process.argv.slice(2));
