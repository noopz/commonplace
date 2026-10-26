#!/usr/bin/env node
/**
 * Regex-only groundedness check: flags numbers/quoted-strings in a generated
 * paper analysis that don't appear anywhere in the paper's own extracted
 * text. A soft signal for paper-reflection-agent — never a hard gate.
 *
 * Usage: node scripts/paper/groundedness-check.ts <analysis-file> <source-text-file>
 */
import { readFileSync } from "fs";
import { parseArgs } from "util";
import { checkGroundedness } from "../lib/groundedness.ts";

const { positionals } = parseArgs({ allowPositionals: true });
const [analysisPath, sourcePath] = positionals;

if (!analysisPath || !sourcePath) {
  console.error(
    "Usage: groundedness-check <analysis-file> <source-text-file>",
  );
  process.exit(1);
}

const generatedText = readFileSync(analysisPath, "utf-8");
const sourceText = readFileSync(sourcePath, "utf-8");

console.log(JSON.stringify(checkGroundedness(generatedText, sourceText)));
