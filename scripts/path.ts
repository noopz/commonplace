#!/usr/bin/env tsx
/** `commonplace path` — CLI twin of vault_path; see graph-cli.ts. */
import { run } from "./graph-cli.js";
await run("path", process.argv.slice(2));
