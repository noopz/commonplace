/**
 * Reading the lines one eval session wrote to `<vault>/.wiki/hook-log.jsonl`.
 *
 * By timestamp, not byte offset: every `session.start` trims the log to its
 * last 2000 lines, so once the log is that long each new session SHRINKS the
 * file and an offset taken before it points past the end — the session's own
 * lines read as nothing. The evals run one session at a time, so "at or after
 * the moment the session was spawned" is exactly that session's lines.
 */
import { readFileSync } from "fs";

export type LogLine = { at?: string; stage?: string; [k: string]: unknown };

/** Lines of `text` stamped at or after `sinceIso`; unparseable or unstamped lines are dropped. */
export function linesAfter(text: string, sinceIso: string): LogLine[] {
  const out: LogLine[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    let line: LogLine;
    try {
      line = JSON.parse(l) as LogLine;
    } catch {
      continue;
    }
    if (typeof line.at === "string" && line.at >= sinceIso) out.push(line);
  }
  return out;
}

/** The log's lines since `sinceIso`, or none when it cannot be read. */
export function logLinesSince(logPath: string, sinceIso: string): LogLine[] {
  try {
    return linesAfter(readFileSync(logPath, "utf-8"), sinceIso);
  } catch {
    return [];
  }
}
