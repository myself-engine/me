// Source-of-truth model and share policy (DECISIONS §15 설정 통합 관리). Pure.
//
// source.json:
//   { "mcpServers":   { "<name>": { command?, args?, env?, url?, headers?, type?, scope?, share } },
//     "instructions": { "<name>": { "file": "fragment.md", "share": ... } } }
// `share` is "all" or a list of harness ids. `url`/`headers`/`type` are an extension beyond
// command/args/env: about half the servers on a real machine are remote (http) servers.
// `scope` only matters for Claude Code: "project" routes the server to <projectDir>/.mcp.json
// instead of ~/.claude.json. Other harnesses only have a user-level file here.
// Secrets never live in source.json: env/header values may be `${env:NAME}` or `${file:~/path}`
// references, resolved only when a harness file is rendered.

export const HARNESSES = ["claude-code", "codex", "opencode", "gjc"] as const;
export type HarnessId = (typeof HARNESSES)[number];
export type Share = "all" | HarnessId[];
export type Scope = "user" | "project";
export type ServerType = "stdio" | "http" | "sse";

/** Harness-neutral MCP server. Adapters translate to and from each harness's native shape. */
export interface McpServer {
  type: ServerType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface SourceServer extends Omit<McpServer, "type"> {
  type?: ServerType;
  share: Share;
  scope?: Scope;
}

export interface SourceInstruction {
  /** Path to a markdown fragment, relative to source.json (or absolute / `~/`). */
  file: string;
  share: Share;
}

export interface Source {
  mcpServers: Record<string, SourceServer>;
  instructions: Record<string, SourceInstruction>;
}

export type Section = "mcpServers" | "instructions";

/** One harness file the plugin can render into. */
export interface Target {
  /** e.g. `claude-code:user`, `claude-code:project`, `codex:user`, `codex:instructions`. */
  id: string;
  harness: HarnessId;
  section: Section;
  scope: Scope;
}

export const isHarness = (h: unknown): h is HarnessId => typeof h === "string" && (HARNESSES as readonly string[]).includes(h);

export function sharedWith(share: Share, harness: HarnessId): boolean {
  return share === "all" || share.includes(harness);
}

/** Whether a declared source item belongs in this target. */
export function routes(item: { share: Share; scope?: Scope }, target: Target): boolean {
  if (!sharedWith(item.share, target.harness)) return false;
  if (target.section === "instructions") return true;
  const scope = item.scope ?? "user";
  // Only Claude Code distinguishes scopes; a project-scoped server lands in other harnesses' user files.
  return target.harness === "claude-code" ? scope === target.scope : target.scope === "user";
}

export function normalizeServer(s: Partial<McpServer> & Record<string, unknown>): McpServer {
  const out: McpServer = { type: s.type ?? (s.url ? "http" : "stdio") };
  if (s.command) out.command = s.command;
  if (s.args?.length) out.args = [...s.args];
  if (s.env && Object.keys(s.env).length) out.env = { ...s.env };
  if (s.url) out.url = s.url;
  if (s.headers && Object.keys(s.headers).length) out.headers = { ...s.headers };
  return out;
}

export function toServer(s: SourceServer): McpServer {
  return normalizeServer(s as SourceServer & Record<string, unknown>);
}

const isStringMap = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

function validateShare(share: unknown, where: string): Share {
  if (share === "all") return "all";
  if (Array.isArray(share) && share.length > 0 && share.every(isHarness)) return [...new Set(share)] as HarnessId[];
  throw new Error(`${where}: share must be "all" or a non-empty list of ${HARNESSES.join(", ")}`);
}

/** Validates a parsed source.json. Keys starting with `_` (import metadata) are ignored. */
export function validateSource(raw: unknown): Source {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("source must be an object");
  const r = raw as Record<string, any>;
  const source: Source = { mcpServers: {}, instructions: {} };
  for (const [name, s] of Object.entries<any>(r.mcpServers ?? {})) {
    const at = `mcpServers.${name}`;
    if (!s || typeof s !== "object") throw new Error(`${at}: must be an object`);
    if (!s.command && !s.url) throw new Error(`${at}: command or url is required`);
    if (s.command !== undefined && typeof s.command !== "string") throw new Error(`${at}: command must be a string`);
    if (s.url !== undefined && typeof s.url !== "string") throw new Error(`${at}: url must be a string`);
    if (s.args !== undefined && !(Array.isArray(s.args) && s.args.every((a: unknown) => typeof a === "string")))
      throw new Error(`${at}: args must be a list of strings`);
    if (s.env !== undefined && !isStringMap(s.env)) throw new Error(`${at}: env must map names to strings`);
    if (s.headers !== undefined && !isStringMap(s.headers)) throw new Error(`${at}: headers must map names to strings`);
    if (s.type !== undefined && !["stdio", "http", "sse"].includes(s.type)) throw new Error(`${at}: type must be stdio, http or sse`);
    if (s.scope !== undefined && !["user", "project"].includes(s.scope)) throw new Error(`${at}: scope must be user or project`);
    source.mcpServers[name] = { ...s, share: validateShare(s.share, at) };
  }
  for (const [name, i] of Object.entries<any>(r.instructions ?? {})) {
    const at = `instructions.${name}`;
    if (!i || typeof i.file !== "string" || !i.file) throw new Error(`${at}: file is required`);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`${at}: name may only use letters, digits, . _ -`);
    source.instructions[name] = { file: i.file, share: validateShare(i.share, at) };
  }
  return source;
}
