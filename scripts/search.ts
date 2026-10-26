#!/usr/bin/env node
/** `commonplace search` — CLI twin of vault_search; see graph-cli.ts. */
import { run } from "./graph-cli.ts";
await run("search", process.argv.slice(2));
