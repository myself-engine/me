// JSON harness files: Claude Code (~/.claude.json, <project>/.mcp.json), OpenCode (opencode.json), GJC (mcp.json).
// Formats were checked read-only against this machine's files on 2026-10-10:
//   Claude Code  mcpServers.<n> = { type: "stdio", command, args, env } | { type: "http", url, headers }
//                Claude itself writes `args: []` and `env: {}` for stdio servers, so we do too.
//                Only the top-level mcpServers (user scope) is owned; projects.*.mcpServers (local scope)
//                is left alone.
//   OpenCode     mcp.<n> = { type: "local", command: [exe, ...args], environment, enabled, timeout }
//                        | { type: "remote", url, headers, enabled, timeout }
//                Uncertain: OpenCode also reads opencode.jsonc; comments there would make JSON.parse fail,
//                which we report instead of rewriting. "sse" servers are written as remote (OpenCode has
//                no separate sse type that we could confirm).
//   GJC          mcpServers.<n> = { type: "stdio"|"http", command, args, env, url, headers,
//                                   sharing, timeout, oauth, auth }   (shape like Claude's)
// Merge rule: only the neutral fields are owned; any other key in an entry (enabled, timeout, sharing,
// oauth, ...) survives a render, and keys keep their position. JSON formatting is re-emitted with the
// file's detected indentation, so escapes and spacing may normalize; content is otherwise unchanged.
import type { Change } from "../domain/diff.ts";
import { normalizeServer, type McpServer, type Target } from "../domain/model.ts";
import { RefusedError, type HarnessConfigFile } from "../ports/index.ts";

export interface NativeMapping {
  /** Keys inside an entry that the source owns. */
  owned: string[];
  toNative(s: McpServer): Record<string, unknown>;
  fromNative(n: Record<string, any>): McpServer;
}

const strMap = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]))
    : undefined;
const strList = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);

export const claudeMapping: NativeMapping = {
  owned: ["type", "command", "args", "env", "url", "headers"],
  toNative: (s) =>
    s.type === "stdio"
      ? { type: "stdio", command: s.command, args: s.args ?? [], env: s.env ?? {} }
      : { type: s.type, url: s.url, ...(s.headers ? { headers: s.headers } : {}) },
  fromNative: (n) =>
    normalizeServer({ type: n.type, command: n.command, args: strList(n.args), env: strMap(n.env), url: n.url, headers: strMap(n.headers) }),
};

export const gjcMapping: NativeMapping = {
  owned: ["type", "command", "args", "env", "url", "headers"],
  toNative: (s) =>
    s.type === "stdio"
      ? { type: "stdio", command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) }
      : { type: s.type, url: s.url, ...(s.headers ? { headers: s.headers } : {}) },
  fromNative: claudeMapping.fromNative,
};

export const opencodeMapping: NativeMapping = {
  owned: ["type", "command", "environment", "url", "headers"],
  toNative: (s) =>
    s.type === "stdio"
      ? { type: "local", command: [s.command!, ...(s.args ?? [])], ...(s.env ? { environment: s.env } : {}) }
      : { type: "remote", url: s.url, ...(s.headers ? { headers: s.headers } : {}) },
  fromNative: (n) => {
    if (n.type === "remote") return normalizeServer({ type: "http", url: n.url, headers: strMap(n.headers) });
    const cmd = strList(n.command) ?? [];
    return normalizeServer({ type: "stdio", command: cmd[0], args: cmd.slice(1), env: strMap(n.environment) });
  },
};

/** Re-merges an entry: owned keys are replaced (or dropped), others stay in place, new owned keys go last. */
export function mergeEntry(existing: unknown, native: Record<string, unknown>, owned: string[]): Record<string, unknown> {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return native;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(existing)) {
    if (!owned.includes(k)) out[k] = v;
    else if (k in native) out[k] = native[k];
  }
  for (const [k, v] of Object.entries(native)) if (!(k in out)) out[k] = v;
  return out;
}

function detectIndent(text: string): string | number {
  const m = /\n([ \t]+)\S/.exec(text);
  if (m) return m[1]!;
  return text.trim().includes("\n") ? 2 : text.trim() ? 0 : 2;
}

function parseObject(text: string, path: string): Record<string, any> {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new RefusedError(`${path} is not plain JSON (${(err as Error).message}); comments or JSONC are not supported`);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new RefusedError(`${path}: top level is not an object`);
  return obj as Record<string, any>;
}

export function jsonMcpFile(target: Target, path: string, sectionKey: string, mapping: NativeMapping): HarnessConfigFile<McpServer> {
  return {
    target,
    path,
    read(text) {
      if (text === null || !text.trim()) return {};
      const section = parseObject(text, path)[sectionKey];
      if (!section || typeof section !== "object") return {};
      const out: Record<string, McpServer> = {};
      for (const [name, n] of Object.entries<any>(section)) if (n && typeof n === "object") out[name] = mapping.fromNative(n);
      return out;
    },
    render(text, change: Change<McpServer>) {
      const obj = text && text.trim() ? parseObject(text, path) : {};
      const section = obj[sectionKey];
      if (section !== undefined && (typeof section !== "object" || section === null || Array.isArray(section)))
        throw new RefusedError(`${path}: ${sectionKey} is not an object`);
      const next: Record<string, unknown> = { ...(section ?? {}) };
      for (const [name, s] of Object.entries(change.upsert)) next[name] = mergeEntry(next[name], mapping.toNative(s), mapping.owned);
      for (const name of change.remove) delete next[name];
      obj[sectionKey] = next;
      const trailing = text === null || text.endsWith("\n") ? "\n" : "";
      return JSON.stringify(obj, null, detectIndent(text ?? "")) + trailing;
    },
  };
}
