/**
 * Sandbox-safe frontmatter parser (plan §3.11). No Node, no `$`.
 *
 * Covers the YAML subset vault notes use: block mappings and sequences
 * (nested, including compact `key:\n- item` and sequences of mappings), flow
 * sequences/mappings, single/double-quoted scalars with escapes and line
 * folding, block scalars `|`/`>` with chomping and indentation indicators,
 * comments, and multi-line plain scalars.
 *
 * Scalar typing follows js-yaml 3 (what gray-matter uses) for null, booleans,
 * ints (incl. hex/octal/binary/base-60) and floats, so CLI and module agree.
 * ONE deliberate divergence: timestamps stay strings as written. gray-matter
 * turns `created: 2026-01-05` into a Date, which every consumer then has to
 * re-stringify, and which re-serialises as a full ISO timestamp.
 *
 * Anything outside the subset (anchors, aliases, tags, `?` complex keys, merge
 * keys) and anything js-yaml itself rejects (duplicate keys, tab indentation,
 * `a: b: c`) yields `error` and empty `data`. Never throws: a rejected file is
 * recorded `parseError`, and the CLI (gray-matter) stays authoritative for it.
 */

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

export type YamlMap = { [key: string]: YamlValue };

export interface YamlResult {
  data: YamlMap;
  error?: string;
}

class YamlError extends Error {}

function fail(msg: string, line?: number): never {
  throw new YamlError(line === undefined ? msg : `${msg} (line ${line + 1})`);
}

// ── scalar resolution (js-yaml 3 core schema, minus timestamps) ──────────────

const FLOAT_RE = new RegExp(
  "^(?:[-+]?(?:0|[1-9][0-9_]*)(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?" +
    "|\\.[0-9_]+(?:[eE][-+]?[0-9]+)?" +
    "|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\\.[0-9_]*" +
    "|[-+]?\\.(?:inf|Inf|INF)" +
    "|\\.(?:nan|NaN|NAN))$",
);

function isInt(s: string): boolean {
  let body = s;
  if (body[0] === "-" || body[0] === "+") body = body.slice(1);
  if (!body) return false;
  if (body === "0") return true;
  if (body.endsWith("_")) return false;
  if (body[0] === "0") {
    if (body[1] === "b") return /^[01_]*[01][01_]*$/.test(body.slice(2));
    if (body[1] === "x") return /^[0-9a-fA-F_]*[0-9a-fA-F][0-9a-fA-F_]*$/.test(body.slice(2));
    return /^[0-7_]*[0-7][0-7_]*$/.test(body.slice(1));
  }
  if (body[0] === "_") return false;
  const colon = body.indexOf(":");
  const head = colon === -1 ? body : body.slice(0, colon);
  if (!/^[0-9_]*[0-9][0-9_]*$/.test(head) || head.endsWith("_")) return false;
  return colon === -1 || /^(:[0-5]?[0-9])+$/.test(body.slice(colon));
}

function sexagesimal(v: string, parse: (x: string) => number): number {
  let total = 0;
  let base = 1;
  for (const part of v.split(":").reverse()) {
    total += parse(part) * base;
    base *= 60;
  }
  return total;
}

function toInt(s: string): number {
  let v = s.replace(/_/g, "");
  let sign = 1;
  if (v[0] === "-" || v[0] === "+") {
    if (v[0] === "-") sign = -1;
    v = v.slice(1);
  }
  if (v === "0") return 0;
  if (v[0] === "0") {
    if (v[1] === "b") return sign * parseInt(v.slice(2), 2);
    if (v[1] === "x") return sign * parseInt(v, 16);
    return sign * parseInt(v, 8);
  }
  if (v.includes(":")) return sign * sexagesimal(v, (x) => parseInt(x, 10));
  return sign * parseInt(v, 10);
}

function toFloat(s: string): number {
  let v = s.replace(/_/g, "").toLowerCase();
  const sign = v[0] === "-" ? -1 : 1;
  if (v[0] === "-" || v[0] === "+") v = v.slice(1);
  if (v === ".inf") return sign * Infinity;
  if (v === ".nan") return NaN;
  if (v.includes(":")) return sign * sexagesimal(v, (x) => parseFloat(x));
  return sign * parseFloat(v);
}

/** Type a plain (unquoted) scalar the way js-yaml 3 would, timestamps excepted. */
export function resolvePlain(s: string): YamlValue {
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (isInt(s)) return toInt(s);
  if (FLOAT_RE.test(s) && !s.endsWith("_")) return toFloat(s);
  return s;
}

// ── frontmatter split (gray-matter semantics) ────────────────────────────────

/**
 * Split a note into its raw frontmatter block and body exactly as gray-matter
 * does: the file must open with `---` not followed by a fourth `-`; the block
 * ends at the first `\n---`; with no closing delimiter the whole rest of the
 * file is frontmatter and the body is empty.
 */
export function splitFrontmatter(text: string): { matter: string | null; body: string } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!src.startsWith("---") || src.charAt(3) === "-") return { matter: null, body: src };
  let rest = src.slice(3);
  // gray-matter treats text after the opening `---` as a language name.
  const nl = rest.indexOf("\n");
  const firstLine = nl === -1 ? rest : rest.slice(0, nl);
  if (firstLine.trim() !== "") rest = rest.slice(firstLine.length);
  const close = rest.indexOf("\n---");
  if (close === -1) return { matter: rest, body: "" };
  let body = rest.slice(close + 4);
  if (body[0] === "\r") body = body.slice(1);
  if (body[0] === "\n") body = body.slice(1);
  return { matter: rest.slice(0, close), body };
}

// ── parser ───────────────────────────────────────────────────────────────────

function indentOf(line: string): number {
  let n = 0;
  while (line.charCodeAt(n) === 32) n++;
  return n;
}

/** Blank or comment-only line. */
function isBlank(line: string): boolean {
  return /^\s*(#.*)?$/.test(line);
}

function isSeqItem(content: string): boolean {
  return content === "-" || content.startsWith("- ") || content.startsWith("-\t");
}

/** Index where a ` #` comment starts in plain text, or -1. */
function commentStart(s: string): number {
  for (let k = 0; k < s.length; k++) {
    if (s[k] === "#" && (k === 0 || s[k - 1] === " " || s[k - 1] === "\t")) return k;
  }
  return -1;
}

function stripComment(s: string): string {
  const c = commentStart(s);
  return (c === -1 ? s : s.slice(0, c)).trim();
}

const DQ_ESCAPES: Record<string, string> = {
  "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f",
  r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85",
  _: "\xa0", L: " ", P: " ",
};

function setKey(obj: YamlMap, key: string, value: YamlValue, line?: number): void {
  if (Object.prototype.hasOwnProperty.call(obj, key)) fail(`duplicated mapping key "${key}"`, line);
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

class Parser {
  lines: string[];
  i = 0;

  constructor(src: string) {
    this.lines = src.replace(/\r\n?/g, "\n").split("\n");
  }

  /** Advance past blank/comment lines; return the next line index or -1. */
  skipBlank(): number {
    while (this.i < this.lines.length && isBlank(this.lines[this.i])) this.i++;
    if (this.i >= this.lines.length) return -1;
    if (/^ *\t/.test(this.lines[this.i])) fail("tab characters must not be used in indentation", this.i);
    return this.i;
  }

  document(): YamlMap {
    const j = this.skipBlank();
    if (j === -1) return {};
    const ind = indentOf(this.lines[j]);
    const value = this.blockNode(ind, -1);
    if (this.skipBlank() !== -1) fail("unexpected content", this.i);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail("frontmatter is not a mapping");
    }
    return value as YamlMap;
  }

  /** The node whose first line is lines[i], at indent `ind`, owned by a parent at `owner`. */
  blockNode(ind: number, owner: number): YamlValue {
    const content = this.lines[this.i].slice(ind);
    if (isSeqItem(content)) return this.sequence(ind);
    if (findKey(content)) return this.mapping(ind);
    this.i++;
    return this.value(content, owner, false);
  }

  mapping(ind: number): YamlMap {
    const obj: YamlMap = {};
    for (;;) {
      const j = this.skipBlank();
      if (j === -1) break;
      const line = this.lines[j];
      const li = indentOf(line);
      if (li < ind) break;
      if (li > ind) fail("bad indentation of a mapping entry", j);
      const content = line.slice(ind);
      if (isSeqItem(content)) break;
      const kv = findKey(content);
      if (!kv) fail("expected a mapping key", j);
      if (kv.key === "<<") fail("merge keys are not supported", j);
      this.i++;
      setKey(obj, kv.key, this.value(kv.rest, ind, true), j);
    }
    return obj;
  }

  sequence(ind: number): YamlValue[] {
    const arr: YamlValue[] = [];
    for (;;) {
      const j = this.skipBlank();
      if (j === -1) break;
      const line = this.lines[j];
      const li = indentOf(line);
      if (li < ind) break;
      if (li > ind) fail("bad indentation of a sequence entry", j);
      const content = line.slice(ind);
      if (!isSeqItem(content)) break;
      const after = content.slice(1);
      const item = after.replace(/^[ \t]+/, "");
      const col = ind + 1 + (after.length - item.length);
      if (item === "" || item.startsWith("#")) {
        this.i++;
        arr.push(this.value("", ind, false));
      } else if (isSeqItem(item) || findKey(item)) {
        // Re-read the item as if it started on its own line at `col`.
        this.lines[j] = " ".repeat(col) + item;
        arr.push(isSeqItem(item) ? this.sequence(col) : this.mapping(col));
      } else {
        this.i++;
        arr.push(this.value(item, ind, false));
      }
    }
    return arr;
  }

  /**
   * The value text after `key:` or `- ` (lines[i] is the line after it).
   * `owner` is the indent of the key/dash; nested content must be deeper,
   * except a compact block sequence directly under a mapping key.
   */
  value(rest: string, owner: number, isMapValue: boolean): YamlValue {
    const r = rest.replace(/^[ \t]+/, "");
    const lineNo = this.i - 1;
    if (r === "" || r.startsWith("#")) {
      const j = this.skipBlank();
      if (j === -1) return null;
      const li = indentOf(this.lines[j]);
      if (li > owner) return this.blockNode(li, owner);
      if (isMapValue && li === owner && isSeqItem(this.lines[j].slice(li))) return this.sequence(li);
      return null;
    }
    const c = r[0];
    if (c === "|" || c === ">") return this.blockScalar(r, owner, lineNo);
    if (c === "&" || c === "*" || c === "!") fail("anchors, aliases and tags are not supported", lineNo);
    if (c === "@" || c === "`") fail(`reserved indicator "${c}"`, lineNo);
    if (c === '"' || c === "'" || c === "[" || c === "{") return this.flowLike(r, lineNo);
    if (isSeqItem(r) || r === "?" || r.startsWith("? ")) fail("block collection not allowed here", lineNo);
    return this.plain(r, owner, lineNo);
  }

  /** Quoted or flow value, possibly spanning lines; trailing text must be a comment. */
  flowLike(r: string, lineNo: number): YamlValue {
    let fp = new FlowParser(r);
    let value: YamlValue;
    try {
      value = fp.node();
    } catch (e) {
      if (!(e instanceof EndOfInput)) throw e;
      // Unterminated on this line: re-parse with the following lines attached.
      fp = new FlowParser(r + "\n" + this.lines.slice(this.i).join("\n"));
      try {
        value = fp.node();
      } catch (e2) {
        if (e2 instanceof EndOfInput) fail("unexpected end of the stream within a flow collection or quoted scalar", lineNo);
        throw e2;
      }
    }
    const consumed = fp.newlinesBefore(fp.p);
    this.i += consumed;
    const tail = fp.restOfLine();
    if (!/^([ \t]+#.*)?[ \t]*$/.test(tail)) {
      fail(/^\s*:/.test(tail) ? "mapping values are not allowed here" : "unexpected text after value", lineNo + consumed);
    }
    return value;
  }

  plain(r: string, owner: number, lineNo: number): YamlValue {
    const c = commentStart(r);
    let text = (c === -1 ? r : r.slice(0, c)).trim();
    if (findKey(text)) fail("mapping values are not allowed here", lineNo);
    let ended = c !== -1;
    let breaks = 0;
    while (!ended && this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (line.trim() === "") {
        breaks++;
        this.i++;
        continue;
      }
      if (indentOf(line) <= owner || /^\s*#/.test(line)) break;
      const lc = commentStart(line);
      const piece = (lc === -1 ? line : line.slice(0, lc)).trim();
      if (findKey(piece)) fail("bad indentation of a mapping entry", this.i);
      text += breaks > 0 ? "\n".repeat(breaks) : " ";
      text += piece;
      breaks = 0;
      ended = lc !== -1;
      this.i++;
    }
    return resolvePlain(text);
  }

  blockScalar(header: string, owner: number, lineNo: number): string {
    const m = /^([|>])([-+]?)([1-9]?)([-+]?)[ \t]*(#.*)?$/.exec(header);
    if (!m || (m[2] && m[4])) fail("bad block scalar header", lineNo);
    const folded = m[1] === ">";
    const chomp = m[2] || m[4];
    let textIndent = m[3] ? Math.max(owner, 0) + Number(m[3]) : -1;
    // A top-level owner of -1 means indent 0 is allowed for content.
    const minIndent = owner + 1;
    let result = "";
    let emptyLines = 0;
    let didRead = false;
    let moreIndented = false;
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (line.trim() === "") {
        emptyLines++;
        this.i++;
        continue;
      }
      const li = indentOf(line);
      if (textIndent === -1) {
        if (li < minIndent) break;
        textIndent = li;
      }
      if (li < textIndent) break;
      const content = line.slice(textIndent);
      if (folded) {
        if (content[0] === " " || content[0] === "\t") {
          moreIndented = true;
          result += "\n".repeat(didRead ? 1 + emptyLines : emptyLines);
        } else if (moreIndented) {
          moreIndented = false;
          result += "\n".repeat(emptyLines + 1);
        } else if (emptyLines === 0) {
          if (didRead) result += " ";
        } else {
          result += "\n".repeat(emptyLines);
        }
      } else {
        result += "\n".repeat(didRead ? 1 + emptyLines : emptyLines);
      }
      result += content;
      didRead = true;
      emptyLines = 0;
      this.i++;
    }
    if (chomp === "+") result += "\n".repeat(didRead ? 1 + emptyLines : emptyLines);
    else if (chomp === "" && didRead) result += "\n";
    return result;
  }
}

/** Split `key: rest` (or `key:`), or null when the content is not a mapping entry. */
function findKey(content: string): { key: string; rest: string } | null {
  const c = content[0];
  if (c === undefined) return null;
  if (c === '"' || c === "'") {
    let fp: FlowParser;
    let key: YamlValue;
    try {
      fp = new FlowParser(content);
      key = fp.quoted();
    } catch {
      return null;
    }
    const after = content.slice(fp.p);
    const m = /^[ \t]*:(?=[ \t]|$)/.exec(after);
    if (!m) return null;
    return { key: String(key), rest: after.slice(m[0].length) };
  }
  if ("[]{},#&*!|>%@`".includes(c) || isSeqItem(content) || content.startsWith("? ")) return null;
  for (let k = 0; k < content.length; k++) {
    const ch = content[k];
    if (ch === "#" && k > 0 && (content[k - 1] === " " || content[k - 1] === "\t")) return null;
    if (ch === ":" && (k + 1 === content.length || content[k + 1] === " " || content[k + 1] === "\t")) {
      const key = content.slice(0, k).trim();
      if (!key) return null;
      return { key: String(key), rest: content.slice(k + 1) };
    }
  }
  return null;
}

class EndOfInput extends Error {}

/** Flow collections and quoted scalars over one string that may contain newlines. */
class FlowParser {
  p = 0;
  constructor(public s: string) {}

  newlinesBefore(pos: number): number {
    let n = 0;
    for (let k = 0; k < pos; k++) if (this.s.charCodeAt(k) === 10) n++;
    return n;
  }

  restOfLine(): string {
    const nl = this.s.indexOf("\n", this.p);
    return nl === -1 ? this.s.slice(this.p) : this.s.slice(this.p, nl);
  }

  peek(): string {
    if (this.p >= this.s.length) throw new EndOfInput();
    return this.s[this.p];
  }

  skipWs(): void {
    while (this.p < this.s.length) {
      const ch = this.s[this.p];
      if (ch === " " || ch === "\t" || ch === "\n") this.p++;
      else if (ch === "#" && (this.p === 0 || /[ \t\n]/.test(this.s[this.p - 1]))) {
        while (this.p < this.s.length && this.s[this.p] !== "\n") this.p++;
      } else break;
    }
  }

  node(): YamlValue {
    this.skipWs();
    const ch = this.peek();
    if (ch === "[") return this.seq();
    if (ch === "{") return this.map();
    if (ch === '"' || ch === "'") return this.quoted();
    if (ch === "&" || ch === "*" || ch === "!") fail("anchors, aliases and tags are not supported");
    return this.plainFlow();
  }

  seq(): YamlValue[] {
    this.p++;
    const out: YamlValue[] = [];
    for (;;) {
      this.skipWs();
      if (this.peek() === "]") {
        this.p++;
        return out;
      }
      const v = this.node();
      this.skipWs();
      const ch = this.peek();
      if (ch === ":") fail("mappings inside flow sequences are not supported");
      out.push(v);
      if (ch === ",") this.p++;
      else if (ch === "]") {
        this.p++;
        return out;
      } else fail("missed comma between flow collection entries");
    }
  }

  map(): YamlMap {
    this.p++;
    const out: YamlMap = {};
    for (;;) {
      this.skipWs();
      if (this.peek() === "}") {
        this.p++;
        return out;
      }
      const ch0 = this.peek();
      const key = ch0 === '"' || ch0 === "'" ? this.quoted() : this.plainFlow(true);
      this.skipWs();
      let value: YamlValue = null;
      if (this.peek() === ":") {
        this.p++;
        this.skipWs();
        const nx = this.peek();
        value = nx === "," || nx === "}" ? null : this.node();
        this.skipWs();
      }
      setKey(out, key === null ? "null" : String(key), value);
      const ch = this.peek();
      if (ch === ",") this.p++;
      else if (ch === "}") {
        this.p++;
        return out;
      } else fail("missed comma between flow collection entries");
    }
  }

  plainFlow(isKey = false): YamlValue {
    const start = this.p;
    if ("]},#".includes(this.s[this.p] ?? "")) fail("unexpected character in flow collection");
    let out = "";
    let line = "";
    while (this.p < this.s.length) {
      const ch = this.s[this.p];
      if (ch === "," || ch === "]" || ch === "}" || ch === "[" || ch === "{") break;
      if (ch === ":" && (isKey || /[ \t\n,\]}]/.test(this.s[this.p + 1] ?? " "))) break;
      if (ch === "#" && /[ \t]/.test(this.s[this.p - 1] ?? "")) break;
      if (ch === "\n") {
        out += (out && line.trim() ? " " : "") + line.trim();
        line = "";
        this.p++;
        continue;
      }
      line += ch;
      this.p++;
    }
    if (this.p >= this.s.length) throw new EndOfInput();
    out += (out && line.trim() ? " " : "") + line.trim();
    if (this.p === start) fail("unexpected character in flow collection");
    return resolvePlain(out.trim());
  }

  /** A single- or double-quoted scalar starting at p, with YAML line folding. */
  quoted(): string {
    const q = this.s[this.p];
    this.p++;
    let out = "";
    for (;;) {
      if (this.p >= this.s.length) throw new EndOfInput();
      const ch = this.s[this.p];
      if (ch === q) {
        if (q === "'" && this.s[this.p + 1] === "'") {
          out += "'";
          this.p += 2;
          continue;
        }
        this.p++;
        return out;
      }
      if (ch === "\n") {
        out = out.replace(/[ \t]+$/, "");
        this.p++;
        out += this.fold();
        continue;
      }
      if (q === '"' && ch === "\\") {
        const e = this.s[this.p + 1];
        if (e === undefined) throw new EndOfInput();
        if (e === "\n") {
          this.p += 2;
          const f = this.fold();
          out += f === " " ? "" : f;
          continue;
        }
        if (e === "x" || e === "u" || e === "U") {
          const len = e === "x" ? 2 : e === "u" ? 4 : 8;
          const hex = this.s.slice(this.p + 2, this.p + 2 + len);
          if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) fail("bad escape sequence in a double-quoted scalar");
          out += String.fromCodePoint(parseInt(hex, 16));
          this.p += 2 + len;
          continue;
        }
        const rep = DQ_ESCAPES[e];
        if (rep === undefined) fail(`unknown escape sequence "\\${e}"`);
        out += rep;
        this.p += 2;
        continue;
      }
      out += ch;
      this.p++;
    }
  }

  /** After a line break inside a quoted scalar: skip blank lines and indentation. */
  fold(): string {
    let breaks = 0;
    for (;;) {
      while (this.p < this.s.length && (this.s[this.p] === " " || this.s[this.p] === "\t")) this.p++;
      if (this.s[this.p] === "\n") {
        breaks++;
        this.p++;
        continue;
      }
      break;
    }
    return breaks > 0 ? "\n".repeat(breaks) : " ";
  }
}

/** Parse a raw frontmatter block (without delimiters). Never throws. */
export function parseYaml(src: string): YamlResult {
  try {
    return { data: new Parser(src).document() };
  } catch (e) {
    const msg = e instanceof YamlError || e instanceof EndOfInput ? e.message || "unexpected end of input" : String(e);
    return { data: {}, error: msg };
  }
}

/**
 * Split and parse a note's frontmatter. `hasFrontmatter` is false when the
 * file does not open with a frontmatter block (data is then `{}`).
 */
export function parseFrontmatter(text: string): YamlResult & { body: string; hasFrontmatter: boolean } {
  const { matter, body } = splitFrontmatter(text);
  if (matter === null) return { data: {}, body, hasFrontmatter: false };
  return { ...parseYaml(matter), body, hasFrontmatter: true };
}
