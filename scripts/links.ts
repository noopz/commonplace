#!/usr/bin/env node
/** `commonplace links` — CLI twin of vault_links; see graph-cli.ts. */
import { run } from "./graph-cli.ts";
await run("links", process.argv.slice(2));
