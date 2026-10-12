// CLI bridge config: validation, parameter checking and placeholder substitution. Pure, no I/O.
//
// A command is an argv template. `{name}` is replaced by the value of declared param `name`,
// either as a whole argv element or inside one element ("--repo={repo}"). Substitution never
// splits or joins elements and nothing runs through a shell, so a value is always exactly one
// argument. argv[0] cannot contain placeholders.

export type ParamType = "string" | "number" | "boolean";
export type ParseMode = "text" | "json" | "lines";

export interface ParamSpec {
  type: ParamType;
  required?: boolean;
  /** Regular expression the stringified value must match. */
  pattern?: string;
  enum?: (string | number | boolean)[];
  default?: string | number | boolean;
  description?: string;
}

export interface CommandSpec {
  argv: string[];
  params?: Record<string, ParamSpec>;
  /** Working directory; relative paths resolve against the config's top-level `cwd`. */
  cwd?: string;
  timeoutMs?: number;
  parse?: ParseMode;
  /** Send each stdout line as op.update({ line }) on streaming calls. */
  stream?: boolean;
  /** Treat a non-zero exit as an error instead of a result. */
  failOnNonZero?: boolean;
  description?: string;
}

export interface CliConfig {
  commands: Record<string, CommandSpec>;
  /** Base directory for commands' relative `cwd`; defaults to the plugin's working directory. */
  cwd?: string;
}

export type ParamValue = string | number | boolean;

export const DEFAULT_TIMEOUT_MS = 25_000;
export const STDERR_LIMIT = 8 * 1024;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const METHOD_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const PARAM_TYPES = new Set(["string", "number", "boolean"]);
const PARSE_MODES = new Set(["text", "json", "lines"]);

export function placeholders(s: string): string[] {
  return [...s.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

function typeOk(type: ParamType, v: unknown): v is ParamValue {
  if (type === "number") return typeof v === "number" && Number.isFinite(v);
  return typeof v === type;
}

/** Checks param declarations, reporting each problem through `at`; shared with the HTTP bridge. */
export function checkParamSpecs(raw: unknown, at: (msg: string) => void): Record<string, ParamSpec> {
  const params = (raw ?? {}) as Record<string, ParamSpec>;
  if (typeof params !== "object" || Array.isArray(params)) {
    at("params must be an object");
    return {};
  }
  for (const [p, spec] of Object.entries(params)) {
    if (!spec || !PARAM_TYPES.has(spec.type)) {
      at(`params.${p}.type must be string, number or boolean`);
      continue;
    }
    if (spec.pattern !== undefined) {
      try {
        new RegExp(spec.pattern);
      } catch {
        at(`params.${p}.pattern is not a valid regular expression`);
      }
    }
    if (spec.enum !== undefined && (!Array.isArray(spec.enum) || !spec.enum.every((e) => typeOk(spec.type, e)))) {
      at(`params.${p}.enum must be an array of ${spec.type}`);
    }
    if (spec.default !== undefined && !typeOk(spec.type, spec.default)) at(`params.${p}.default must be a ${spec.type}`);
  }
  return params;
}

/** Throws with every problem found; returns the config typed. */
export function validateConfig(raw: unknown): CliConfig {
  const errs: string[] = [];
  const cfg = raw as CliConfig;
  if (!cfg || typeof cfg !== "object" || !cfg.commands || typeof cfg.commands !== "object" || Array.isArray(cfg.commands)) {
    throw new Error("config.commands must be an object of { <method>: { argv, ... } }");
  }
  if (cfg.cwd !== undefined && typeof cfg.cwd !== "string") errs.push("cwd must be a string");
  const names = Object.keys(cfg.commands);
  if (names.length === 0) errs.push("config.commands is empty");
  for (const name of names) {
    const c = cfg.commands[name]!;
    const at = (msg: string) => errs.push(`commands.${name}: ${msg}`);
    if (!METHOD_RE.test(name)) at("method name must match " + METHOD_RE);
    if (!c || typeof c !== "object") {
      at("must be an object");
      continue;
    }
    if (!Array.isArray(c.argv) || c.argv.length === 0 || !c.argv.every((a) => typeof a === "string")) {
      at("argv must be a non-empty array of strings");
      continue;
    }
    const params = checkParamSpecs(c.params, at);
    if (placeholders(c.argv[0]!).length) at("argv[0] cannot contain placeholders");
    for (const el of c.argv) for (const ph of placeholders(el)) if (!(ph in params)) at(`argv uses undeclared param {${ph}}`);
    if (c.cwd !== undefined) {
      if (typeof c.cwd !== "string") at("cwd must be a string");
      else for (const ph of placeholders(c.cwd)) if (!(ph in params)) at(`cwd uses undeclared param {${ph}}`);
    }
    if (c.timeoutMs !== undefined && !(Number.isInteger(c.timeoutMs) && c.timeoutMs > 0)) at("timeoutMs must be a positive integer");
    if (c.parse !== undefined && !PARSE_MODES.has(c.parse)) at("parse must be text, json or lines");
    if (c.stream !== undefined && typeof c.stream !== "boolean") at("stream must be a boolean");
    if (c.failOnNonZero !== undefined && typeof c.failOnNonZero !== "boolean") at("failOnNonZero must be a boolean");
  }
  if (errs.length) throw new Error(`invalid cli bridge config: ${errs.join("; ")}`);
  return cfg;
}

/**
 * Checks call params against the command's declarations and fills defaults.
 * Unknown params, wrong types, missing required params and pattern/enum mismatches are errors.
 */
export function validateParams(cmd: CommandSpec, raw: unknown): Record<string, ParamValue> {
  return checkParams(cmd.params, raw);
}

/** validateParams for any param declarations; shared with the HTTP bridge. */
export function checkParams(specs: Record<string, ParamSpec> = {}, raw: unknown): Record<string, ParamValue> {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("params must be an object");
  const given = raw as Record<string, unknown>;
  const errs: string[] = [];
  const out: Record<string, ParamValue> = {};
  for (const k of Object.keys(given)) if (!(k in specs)) errs.push(`unknown param: ${k}`);
  for (const [k, spec] of Object.entries(specs)) {
    const v = given[k] ?? spec.default;
    if (v === undefined) {
      if (spec.required) errs.push(`missing required param: ${k}`);
      continue;
    }
    if (!typeOk(spec.type, v)) {
      errs.push(`param ${k} must be a ${spec.type}`);
      continue;
    }
    if (spec.enum && !spec.enum.includes(v)) errs.push(`param ${k} must be one of ${JSON.stringify(spec.enum)}`);
    if (spec.pattern && !new RegExp(spec.pattern).test(String(v))) errs.push(`param ${k} does not match ${spec.pattern}`);
    out[k] = v;
  }
  if (errs.length) throw new Error(errs.join("; "));
  return out;
}

/** Replaces placeholders in one template string; null when it references an absent (optional) param. */
function fill(template: string, values: Record<string, ParamValue>): string | null {
  let missing = false;
  const s = template.replace(PLACEHOLDER, (_, name: string) => {
    if (!(name in values)) {
      missing = true;
      return "";
    }
    return String(values[name]);
  });
  return missing ? null : s;
}

/**
 * Builds the child argv. Each template element yields at most one element; an element that
 * references an absent optional param is dropped (so `"--limit={limit}"` disappears when unset).
 */
export function substituteArgv(argv: string[], values: Record<string, ParamValue>): string[] {
  const out: string[] = [];
  for (const el of argv) {
    const v = fill(el, values);
    if (v !== null) out.push(v);
  }
  return out;
}

/** Substitutes the command's cwd template; an absent optional param there is an error. */
export function substituteCwd(cwd: string, values: Record<string, ParamValue>): string {
  const v = fill(cwd, values);
  if (v === null) throw new Error(`cwd ${cwd} needs a param that was not given`);
  return v;
}

/** Instance manifest for a CLI bridge plugin: provides.methods is exactly the configured command names. */
export function renderManifest(pluginId: string, config: CliConfig, bridgeMain: string) {
  return {
    id: pluginId,
    version: "0.1.0",
    protocol: { min: 1, max: 1 },
    run: { command: ["bun", bridgeMain] },
    permissions: ["shell"],
    provides: { methods: Object.keys(validateConfig(config).commands) },
    restart: { policy: "on-failure", maxRestarts: 5, windowSec: 300 },
  };
}
