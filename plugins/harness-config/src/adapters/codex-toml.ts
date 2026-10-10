// Codex: ~/.codex/config.toml, tables [mcp_servers.<name>].
// Format checked read-only against this machine's file (2026-10-10) and Codex's source
// (codex-rs/config/src/mcp_types.rs, McpServerTransportConfig: Stdio | StreamableHttp only):
//   [mcp_servers.<n>]  command, args, env (sub-table [mcp_servers.<n>.env]), enabled, startup_timeout_sec
//   [mcp_servers.<n>]  url, http_headers (streamable HTTP)
// Codex has no `type` key: a url means streamable HTTP. Codex has no SSE transport, so an "sse"
// source server is written as a plain url (uncertain whether such a server then works).
// `bearer_token_env_var`, `env_http_headers`, `http_headers_helper`, `env_vars`, `cwd`, `enabled`,
// timeouts and anything else are harness-only keys we never own.
//
// Rendering splices text so comments and unrelated tables survive byte-for-byte: only the line
// ranges of owned [mcp_servers.<n>...] tables are replaced, removed or appended. We refuse (unless
// `force`) when that cannot be done safely:
//   - a comment sits inside a table we would rewrite or remove;
//   - mcp_servers is written as inline tables or dotted keys rather than [mcp_servers.<n>] tables.
// With `force` the first case drops those comments only; the second rewrites the whole file with
// Bun.TOML.stringify, which loses every comment and the original formatting.
// Every splice is verified by re-parsing: all non-owned data must be unchanged, or we refuse.
import type { Change } from "../domain/diff.ts";
import { normalizeServer, type McpServer, type Target } from "../domain/model.ts";
import { RefusedError, type HarnessConfigFile } from "../ports/index.ts";
import { mergeEntry } from "./json-mcp.ts";

const OWNED = ["command", "args", "env", "url", "http_headers"];

function toNative(s: McpServer): Record<string, unknown> {
  if (s.type === "stdio") return { command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) };
  return { url: s.url, ...(s.headers ? { http_headers: s.headers } : {}) };
}

const strMap = (v: unknown) =>
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)])) : undefined;

function fromNative(n: Record<string, any>): McpServer {
  return normalizeServer({
    type: n.url ? "http" : "stdio",
    command: n.command,
    args: Array.isArray(n.args) ? n.args.map(String) : undefined,
    env: strMap(n.env),
    url: n.url,
    headers: strMap(n.http_headers),
  });
}

// ---------- line scanner ----------

export interface TomlHeader {
  line: number;
  path: string[];
}

export interface TomlScan {
  lines: string[];
  headers: TomlHeader[];
  /** Lines holding a comment (whole-line or trailing), outside strings. */
  comments: Set<number>;
  /** Lines before the first header that hold a key/value. */
  rootKeyLines: number[];
}

/** Splits a dotted key path, honoring "basic" and 'literal' quoted segments. */
export function splitKey(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    while (src[i] === " " || src[i] === "\t") i++;
    let seg = "";
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      seg = JSON.parse(src.slice(i, j + 1));
      i = j + 1;
    } else if (src[i] === "'") {
      const j = src.indexOf("'", i + 1);
      seg = src.slice(i + 1, j);
      i = j + 1;
    } else {
      let j = i;
      while (j < src.length && src[j] !== ".") j++;
      seg = src.slice(i, j).trim();
      i = j;
    }
    out.push(seg);
    while (src[i] === " " || src[i] === "\t") i++;
    if (src[i] === ".") i++;
  }
  return out;
}

/** Tracks strings, multi-line strings and bracket depth so headers are only found at top level. */
export function scanToml(text: string): TomlScan {
  const lines = text.split("\n");
  const headers: TomlHeader[] = [];
  const comments = new Set<number>();
  const rootKeyLines: number[] = [];
  let multi: '"""' | "'''" | null = null;
  let depth = 0;
  lines.forEach((line, n) => {
    let i = 0;
    if (!multi && depth === 0) {
      const m = /^\s*(\[\[?)\s*(.*?)\s*(\]\]?)\s*(#.*)?$/.exec(line);
      if (m && m[1]!.length === m[3]!.length) {
        headers.push({ line: n, path: splitKey(m[2]!) });
        if (m[4]) comments.add(n);
        return;
      }
      if (headers.length === 0 && /^\s*[^\s#]/.test(line)) rootKeyLines.push(n);
    }
    while (i < line.length) {
      if (multi) {
        const end = line.indexOf(multi, i);
        if (end < 0) return;
        i = end + 3;
        multi = null;
        continue;
      }
      const c = line[i]!;
      if (c === "#") {
        comments.add(n);
        return;
      }
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        multi = line.slice(i, i + 3) as '"""' | "'''";
        i += 3;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      if (c === "'") {
        const end = line.indexOf("'", i + 1);
        i = end < 0 ? line.length : end + 1;
        continue;
      }
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
      i++;
    }
  });
  return { lines, headers, comments, rootKeyLines };
}

interface Range {
  start: number;
  /** Exclusive. Trailing blank and comment-only lines belong to the next table, so they are excluded. */
  end: number;
}

function tableRanges(scan: TomlScan): (TomlHeader & Range)[] {
  return scan.headers.map((h, i) => {
    let end = i + 1 < scan.headers.length ? scan.headers[i + 1]!.line : scan.lines.length;
    while (end > h.line + 1 && /^\s*(#.*)?$/.test(scan.lines[end - 1]!)) end--;
    return { ...h, start: h.line, end };
  });
}

// ---------- render ----------

const deepEqual = (a: unknown, b: unknown) => Bun.deepEquals(a, b);

function parse(text: string, path: string): Record<string, any> {
  try {
    return Bun.TOML.parse(text) as Record<string, any>;
  } catch (err) {
    throw new RefusedError(`${path} is not valid TOML: ${(err as Error).message}`);
  }
}

function blockLines(name: string, native: Record<string, unknown>): string[] {
  const text = Bun.TOML.stringify({ mcp_servers: { [name]: native } }) ?? "";
  return text.replace(/\n+$/, "").split("\n");
}

function applyNative(servers: Record<string, any>, change: Change<McpServer>): Record<string, any> {
  const next = { ...servers };
  for (const [name, s] of Object.entries(change.upsert)) next[name] = mergeEntry(next[name], toNative(s), OWNED);
  for (const name of change.remove) delete next[name];
  return next;
}

export function spliceCodex(text: string, change: Change<McpServer>, opts: { force: boolean; path: string }): string {
  const before = parse(text, opts.path);
  const servers: Record<string, any> = before.mcp_servers ?? {};
  const expected = applyNative(servers, change);
  const touched = [...Object.keys(change.upsert), ...change.remove];
  if (touched.length === 0) return text;

  const scan = scanToml(text);
  const ranges = tableRanges(scan);
  const of = (name: string) => ranges.filter((r) => r.path[0] === "mcp_servers" && r.path[1] === name);
  const layoutOk =
    !ranges.some((r) => r.path.length === 1 && r.path[0] === "mcp_servers" && r.end > r.start + 1) &&
    !scan.rootKeyLines.some((n) => /^\s*["']?mcp_servers\b/.test(scan.lines[n]!)) &&
    Object.keys(servers).every((name) => of(name).length > 0);
  if (!layoutOk) {
    if (!opts.force)
      throw new RefusedError(
        `${opts.path}: mcp_servers uses inline tables or dotted keys, so it cannot be edited in place; --force rewrites the whole file and drops every comment`,
      );
    return Bun.TOML.stringify({ ...before, mcp_servers: expected }) ?? "";
  }

  const commented = touched.filter((name) => (name in servers ? of(name) : []).some((r) => [...scan.comments].some((n) => n >= r.start && n < r.end)));
  if (commented.length && !opts.force)
    throw new RefusedError(`${opts.path}: comments inside [mcp_servers.${commented.join("], [mcp_servers.")}] would be lost; use --force to drop them`);

  type Edit = Range & { lines: string[] };
  const edits: Edit[] = [];
  const dropRange = (r: Range) => {
    // Take one following blank line with the table so removals do not pile up blank lines.
    const end = r.end < scan.lines.length && scan.lines[r.end]!.trim() === "" ? r.end + 1 : r.end;
    edits.push({ start: r.start, end, lines: [] });
  };
  const added: string[] = [];
  for (const name of touched) {
    const rs = name in servers ? of(name) : [];
    if (rs.length === 0) {
      if (name in change.upsert) added.push(name);
      continue;
    }
    rs.forEach((r, i) => {
      if (i === 0 && name in change.upsert) edits.push({ start: r.start, end: r.end, lines: blockLines(name, expected[name]) });
      else dropRange(r);
    });
  }
  if (added.length) {
    const lastMcp = ranges.filter((r) => r.path[0] === "mcp_servers").at(-1);
    const block = added.flatMap((name) => ["", ...blockLines(name, expected[name])]);
    if (lastMcp) edits.push({ start: lastMcp.end, end: lastMcp.end, lines: block });
    else {
      // Append at the end; drop the empty element a trailing newline leaves so spacing stays one blank line.
      let at = scan.lines.length;
      while (at > 0 && scan.lines[at - 1]!.trim() === "") at--;
      edits.push({ start: at, end: scan.lines.length, lines: [...(at > 0 ? block : block.slice(1)), ""] });
    }
  }
  const lines = [...scan.lines];
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end)) lines.splice(e.start, e.end - e.start, ...e.lines);
  const out = lines.join("\n");

  const after = parse(out, opts.path);
  const { mcp_servers: _a, ...restBefore } = before;
  const { mcp_servers: _b, ...restAfter } = after;
  if (!deepEqual(restBefore, restAfter) || !deepEqual(after.mcp_servers ?? {}, expected))
    throw new RefusedError(`${opts.path}: in-place edit did not round-trip; refusing to write`);
  return out;
}

export function codexFile(target: Target, path: string): HarnessConfigFile<McpServer> {
  return {
    target,
    path,
    read(text) {
      if (text === null || !text.trim()) return {};
      const servers = parse(text, path).mcp_servers ?? {};
      return Object.fromEntries(Object.entries<any>(servers).map(([name, n]) => [name, fromNative(n)]));
    },
    render(text, change, opts) {
      return spliceCodex(text ?? "", change, { ...opts, path });
    },
  };
}
