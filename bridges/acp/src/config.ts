// ACP bridge config and the protocol decisions that need no I/O: validation, prompt normalising,
// the permission policy and the instance manifest.
//
// Wire shapes follow Agent Client Protocol v1 as published in @agentclientprotocol/sdk 1.3.0
// (schema/schema.json). Only the fields this bridge reads or writes are typed here.
import { isAbsolute } from "node:path";
import { validateEnvPass } from "@me/env";

export const ACP_PROTOCOL_VERSION = 1;
export const DEFAULT_INIT_TIMEOUT_MS = 30_000;
export const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_CANCEL_GRACE_MS = 5_000;

/** What to answer when the agent asks for permission (session/request_permission). */
export type PermissionPolicy = "reject" | "allow";

export interface AgentCommand {
  command: string;
  args?: string[];
  /** Extra environment variables (non-secret). */
  env?: Record<string, string>;
  /** Environment variables read from files by path at spawn time (for API keys). `~/` expands to home. */
  envFiles?: Record<string, string>;
  /** Extra parent env names kept for the agent process: exact names or PREFIX_* globs. No "*" wildcard. */
  envPass?: string[];
  cwd?: string;
}

export interface AcpConfig {
  agent: AgentCommand;
  /** Default working directory for new sessions; absolute. Defaults to agent.cwd, then the plugin's cwd. */
  cwd?: string;
  permission?: PermissionPolicy;
  initTimeoutMs?: number;
  /** Upper bound for one session/prompt; 0 means none. */
  promptTimeoutMs?: number;
  /** How long to wait for the agent to answer a cancelled prompt before giving up on it. */
  cancelGraceMs?: number;
}

export type ContentBlock = { type: string; [k: string]: unknown };

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export type PermissionOutcome = { outcome: "cancelled" } | { outcome: "selected"; optionId: string };

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const POLICIES = new Set(["reject", "allow"]);

function stringMap(v: unknown): v is Record<string, string> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
}

/** Throws with every problem found; returns the config typed. */
export function validateConfig(raw: unknown): AcpConfig {
  const errs: string[] = [];
  const cfg = raw as AcpConfig;
  if (!cfg || typeof cfg !== "object" || !cfg.agent || typeof cfg.agent !== "object") {
    throw new Error("config.agent must be an object of { command, args?, env?, envFiles?, cwd? }");
  }
  const a = cfg.agent;
  if (typeof a.command !== "string" || !a.command) errs.push("agent.command is required");
  if (a.args !== undefined && (!Array.isArray(a.args) || !a.args.every((x) => typeof x === "string"))) errs.push("agent.args must be an array of strings");
  if (a.env !== undefined && !stringMap(a.env)) errs.push("agent.env must be an object of strings");
  if (a.envFiles !== undefined) {
    if (!stringMap(a.envFiles)) errs.push("agent.envFiles must be an object of file paths");
    else for (const k of Object.keys(a.envFiles)) if (!ENV_RE.test(k)) errs.push(`agent.envFiles: invalid variable name ${k}`);
  }
  if (a.cwd !== undefined && typeof a.cwd !== "string") errs.push("agent.cwd must be a string");
  if (a.envPass !== undefined) {
    try {
      validateEnvPass(a.envPass);
    } catch (err) {
      errs.push(`agent.envPass: ${(err as Error).message}`);
    }
  }
  if (cfg.cwd !== undefined && (typeof cfg.cwd !== "string" || !isAbsolute(cfg.cwd))) errs.push("cwd must be an absolute path");
  if (cfg.permission !== undefined && !POLICIES.has(cfg.permission)) errs.push("permission must be reject or allow");
  const ms = (k: "initTimeoutMs" | "promptTimeoutMs" | "cancelGraceMs", zeroOk: boolean) => {
    const v = cfg[k];
    if (v !== undefined && !(Number.isInteger(v) && (v > 0 || (zeroOk && v === 0)))) errs.push(`${k} must be a ${zeroOk ? "non-negative" : "positive"} integer`);
  };
  ms("initTimeoutMs", false);
  ms("promptTimeoutMs", true);
  ms("cancelGraceMs", false);
  if (errs.length) throw new Error(`invalid acp bridge config: ${errs.join("; ")}`);
  return cfg;
}

/** A prompt is a string (one text block) or ACP content blocks. */
export function toPromptBlocks(prompt: unknown): ContentBlock[] {
  if (typeof prompt === "string") {
    if (!prompt) throw new Error("prompt is empty");
    return [{ type: "text", text: prompt }];
  }
  if (Array.isArray(prompt) && prompt.length && prompt.every((b) => b && typeof b === "object" && typeof b.type === "string")) {
    return prompt as ContentBlock[];
  }
  throw new Error("prompt must be a non-empty string or an array of ACP content blocks");
}

/**
 * Picks the answer to session/request_permission. "reject" chooses a reject option (once before always),
 * "allow" an allow option (once before always); with no matching option the request is answered cancelled.
 */
export function decidePermission(policy: PermissionPolicy, options: PermissionOption[]): PermissionOutcome {
  const order = policy === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const o = (options ?? []).find((x) => x?.kind === kind && typeof x.optionId === "string");
    if (o) return { outcome: "selected", optionId: o.optionId };
  }
  return { outcome: "cancelled" };
}

/** Text of an agent_message_chunk update, or "" for any other update. */
export function messageText(update: any): string {
  if (update?.sessionUpdate !== "agent_message_chunk") return "";
  const c = update.content;
  return c?.type === "text" && typeof c.text === "string" ? c.text : "";
}

export const BRIDGE_METHODS = ["agent.info", "session.new", "session.prompt", "session.cancel"];

/** Instance manifest for an ACP bridge plugin. The method set is fixed; the agent is chosen by config. */
export function renderManifest(pluginId: string, config: AcpConfig, bridgeMain: string) {
  validateConfig(config);
  return {
    id: pluginId,
    version: "0.1.0",
    protocol: { min: 1, max: 1 },
    run: { command: ["bun", bridgeMain] },
    permissions: ["shell"],
    provides: { methods: BRIDGE_METHODS },
    restart: { policy: "on-failure", maxRestarts: 5, windowSec: 300 },
  };
}
