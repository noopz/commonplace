#!/usr/bin/env node
/** `commonplace path` — CLI twin of vault_path; see graph-cli.ts. */
import { run } from "./graph-cli.ts";
await run("path", process.argv.slice(2));
