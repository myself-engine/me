// HTTP bridge config: validation and request building from templates. Pure, no I/O.
//
// An endpoint is a request template. `{name}` is replaced by the value of declared param `name`
// (same param declarations as the CLI bridge). Placeholders may appear only in the URL path, in
// `query` values, in header values and in the body, never in the scheme, host or port, so a caller
// can never send a configured secret header to another server. Path values are percent-encoded
// as one segment piece; query values go through URLSearchParams.
import { checkParamSpecs, checkParams, placeholders, type ParamSpec, type ParamValue } from "../../cli/src/config.ts";

export type { ParamSpec, ParamValue };
export type ParseMode = "text" | "json";
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A header whose value is read from a file at call time; the value never appears in config, results or errors. */
export interface SecretHeader {
  /** Path to the secret file, e.g. ~/.config/me/secrets/github.token. `~/` expands to the home directory. */
  file: string;
  /** How the trimmed file content becomes the header value; `{secret}` marks where it goes. Default "{secret}". */
  format?: string;
}

export type HeaderSpec = string | SecretHeader;
export type BodyTemplate = string | number | boolean | null | BodyTemplate[] | { [k: string]: BodyTemplate };

export interface EndpointSpec {
  method?: HttpMethod;
  /** Absolute http(s) URL, or a path starting with "/" when the config has `baseUrl`. */
  url: string;
  /** Query parameters; values are templates and an entry that references an absent optional param is dropped. */
  query?: Record<string, string>;
  params?: Record<string, ParamSpec>;
  headers?: Record<string, HeaderSpec>;
  /** JSON template. A string that is exactly "{name}" becomes the typed value; a top-level string is sent as text. */
  body?: BodyTemplate;
  parse?: ParseMode;
  timeoutMs?: number;
  /** Response body cap in bytes. */
  maxBytes?: number;
  /** Treat a non-2xx status as an error instead of a result. */
  failOnError?: boolean;
  description?: string;
}

export interface HttpConfig {
  endpoints: Record<string, EndpointSpec>;
  /** Origin (and optional base path) for endpoints whose url is a path. No placeholders. */
  baseUrl?: string;
  /** Headers sent with every endpoint; an endpoint's own header of the same name wins. */
  headers?: Record<string, HeaderSpec>;
  /** Default response body cap for every endpoint. */
  maxBytes?: number;
}

export const DEFAULT_TIMEOUT_MS = 25_000;
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const MAX_BYTES_LIMIT = 64 * 1024 * 1024;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const WHOLE_PLACEHOLDER = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const METHOD_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const PARSE_MODES = new Set(["text", "json"]);

function isSecret(h: unknown): h is SecretHeader {
  return !!h && typeof h === "object" && !Array.isArray(h);
}

function bodyPlaceholders(t: unknown, out: string[] = []): string[] {
  if (typeof t === "string") out.push(...placeholders(t));
  else if (Array.isArray(t)) t.forEach((v) => bodyPlaceholders(v, out));
  else if (t && typeof t === "object") Object.values(t).forEach((v) => bodyPlaceholders(v, out));
  return out;
}

/** Splits an http(s) URL template into its fixed origin and the rest; null if it has no plain origin. */
function splitOrigin(url: string): { origin: string; rest: string } | null {
  const m = /^(https?:\/\/[^/?#]+)(.*)$/i.exec(url);
  if (!m) return null;
  return { origin: m[1]!, rest: m[2]! };
}

function checkHeaders(headers: unknown, declared: Record<string, ParamSpec>, at: (msg: string) => void, where: string) {
  if (headers === undefined) return;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return at(`${where} must be an object`);
  for (const [name, h] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(name)) at(`${where}: invalid header name ${JSON.stringify(name)}`);
    if (typeof h === "string") {
      for (const ph of placeholders(h)) if (!(ph in declared)) at(`${where}.${name} uses undeclared param {${ph}}`);
    } else if (isSecret(h)) {
      if (typeof h.file !== "string" || !h.file) at(`${where}.${name}.file must be a path`);
      if (h.format !== undefined && (typeof h.format !== "string" || !h.format.includes("{secret}"))) {
        at(`${where}.${name}.format must be a string containing {secret}`);
      }
    } else {
      at(`${where}.${name} must be a string or { file, format? }`);
    }
  }
}

/** Throws with every problem found; returns the config typed. */
export function validateConfig(raw: unknown): HttpConfig {
  const errs: string[] = [];
  const cfg = raw as HttpConfig;
  if (!cfg || typeof cfg !== "object" || !cfg.endpoints || typeof cfg.endpoints !== "object" || Array.isArray(cfg.endpoints)) {
    throw new Error("config.endpoints must be an object of { <method>: { url, ... } }");
  }
  if (cfg.baseUrl !== undefined) {
    if (typeof cfg.baseUrl !== "string" || !splitOrigin(cfg.baseUrl)) errs.push("baseUrl must be an http(s) URL");
    else if (placeholders(cfg.baseUrl).length) errs.push("baseUrl cannot contain placeholders");
  }
  const maxOk = (v: unknown) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_BYTES_LIMIT;
  if (cfg.maxBytes !== undefined && !maxOk(cfg.maxBytes)) errs.push(`maxBytes must be an integer in 1..${MAX_BYTES_LIMIT}`);
  checkHeaders(cfg.headers, {}, (m) => errs.push(m), "headers");
  const names = Object.keys(cfg.endpoints);
  if (names.length === 0) errs.push("config.endpoints is empty");
  for (const name of names) {
    const e = cfg.endpoints[name]!;
    const at = (msg: string) => errs.push(`endpoints.${name}: ${msg}`);
    if (!METHOD_RE.test(name)) at("method name must match " + METHOD_RE);
    if (!e || typeof e !== "object") {
      at("must be an object");
      continue;
    }
    const params = checkParamSpecs(e.params, at);
    const method = e.method ?? "GET";
    if (!HTTP_METHODS.has(method)) at(`method must be one of ${[...HTTP_METHODS].join(", ")}`);
    if (typeof e.url !== "string" || !e.url) {
      at("url is required");
      continue;
    }
    let path: string;
    if (e.url.startsWith("/")) {
      if (cfg.baseUrl === undefined) at("url is a path but the config has no baseUrl");
      path = e.url;
    } else {
      const split = splitOrigin(e.url);
      if (!split) {
        at("url must be an http(s) URL or a path starting with /");
        continue;
      }
      if (placeholders(split.origin).length) at("url cannot contain placeholders in the scheme, host or port");
      path = split.rest;
    }
    const q = path.search(/[?#]/);
    if (q >= 0 && placeholders(path.slice(q)).length) at("url placeholders are only allowed in the path; use query for parameters");
    for (const ph of placeholders(path)) {
      if (!(ph in params)) at(`url uses undeclared param {${ph}}`);
      else if (!params[ph]!.required && params[ph]!.default === undefined) at(`url param {${ph}} must be required or have a default`);
    }
    if (e.query !== undefined) {
      if (!e.query || typeof e.query !== "object" || Array.isArray(e.query)) at("query must be an object");
      else
        for (const [k, v] of Object.entries(e.query)) {
          if (typeof v !== "string") at(`query.${k} must be a string`);
          else for (const ph of placeholders(v)) if (!(ph in params)) at(`query.${k} uses undeclared param {${ph}}`);
        }
    }
    checkHeaders(e.headers, params, at, "headers");
    if (e.body !== undefined) {
      if (method === "GET" || method === "HEAD") at(`${method} cannot have a body`);
      for (const ph of bodyPlaceholders(e.body)) if (!(ph in params)) at(`body uses undeclared param {${ph}}`);
    }
    if (e.parse !== undefined && !PARSE_MODES.has(e.parse)) at("parse must be text or json");
    if (e.timeoutMs !== undefined && !(Number.isInteger(e.timeoutMs) && e.timeoutMs > 0)) at("timeoutMs must be a positive integer");
    if (e.maxBytes !== undefined && !maxOk(e.maxBytes)) at(`maxBytes must be an integer in 1..${MAX_BYTES_LIMIT}`);
    if (e.failOnError !== undefined && typeof e.failOnError !== "boolean") at("failOnError must be a boolean");
  }
  if (errs.length) throw new Error(`invalid http bridge config: ${errs.join("; ")}`);
  return cfg;
}

export { checkParams };

/** Replaces placeholders in one template string; null when it references an absent (optional) param. */
function fill(template: string, values: Record<string, ParamValue>, encode: (s: string) => string = (s) => s): string | null {
  let missing = false;
  const s = template.replace(PLACEHOLDER, (_, name: string) => {
    if (!(name in values)) {
      missing = true;
      return "";
    }
    return encode(String(values[name]));
  });
  return missing ? null : s;
}

function encodeSegment(v: string): string {
  // "." and ".." would be resolved away by URL normalisation and move the request to another path.
  if (v === "." || v === "..") throw new Error(`path param value ${JSON.stringify(v)} is not allowed`);
  return encodeURIComponent(v);
}

/** Builds the final URL. Path values are percent-encoded; the origin never changes. */
export function buildUrl(config: Pick<HttpConfig, "baseUrl">, endpoint: EndpointSpec, values: Record<string, ParamValue>): URL {
  const template = endpoint.url.startsWith("/") ? config.baseUrl!.replace(/\/$/, "") + endpoint.url : endpoint.url;
  const { origin, rest } = splitOrigin(template)!;
  const filled = fill(rest, values, encodeSegment);
  if (filled === null) throw new Error(`url ${endpoint.url} needs a param that was not given`);
  const url = new URL(origin + filled);
  if (url.origin !== new URL(origin).origin) throw new Error("url origin changed during substitution");
  for (const [k, v] of Object.entries(endpoint.query ?? {})) {
    const s = fill(v, values);
    if (s !== null) url.searchParams.append(k, s);
  }
  return url;
}

/** Plain (non-secret) header values; an entry that references an absent optional param is dropped. */
export function buildPlainHeaders(headers: Record<string, HeaderSpec>, values: Record<string, ParamValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, h] of Object.entries(headers)) {
    if (typeof h !== "string") continue;
    const v = fill(h, values);
    if (v === null) continue;
    if (/[\r\n\0]/.test(v)) throw new Error(`header ${name} would contain a line break`);
    out[name] = v;
  }
  return out;
}

const ABSENT = Symbol("absent");

function fillBody(t: BodyTemplate, values: Record<string, ParamValue>): BodyTemplate | typeof ABSENT {
  if (typeof t === "string") {
    const whole = WHOLE_PLACEHOLDER.exec(t);
    if (whole) return whole[1]! in values ? values[whole[1]!]! : ABSENT;
    const s = fill(t, values);
    return s === null ? ABSENT : s;
  }
  if (Array.isArray(t)) {
    return t.map((v) => fillBody(v, values)).filter((v): v is BodyTemplate => v !== ABSENT);
  }
  if (t && typeof t === "object") {
    const out: Record<string, BodyTemplate> = {};
    for (const [k, v] of Object.entries(t)) {
      const f = fillBody(v, values);
      if (f !== ABSENT) out[k] = f;
    }
    return out;
  }
  return t;
}

/**
 * Builds the request body. A top-level string template is sent as text; anything else as JSON.
 * Values that reference an absent optional param are dropped from their object or array.
 */
export function buildBody(endpoint: EndpointSpec, values: Record<string, ParamValue>): { body: string; contentType: string } | null {
  if (endpoint.body === undefined) return null;
  const filled = fillBody(endpoint.body, values);
  if (typeof endpoint.body === "string") {
    if (filled === ABSENT) return null;
    return { body: String(filled), contentType: "text/plain; charset=utf-8" };
  }
  return { body: JSON.stringify(filled === ABSENT ? null : filled), contentType: "application/json" };
}

/** Instance manifest for an HTTP bridge plugin: provides.methods is exactly the configured endpoint names. */
export function renderManifest(pluginId: string, config: HttpConfig, bridgeMain: string) {
  return {
    id: pluginId,
    version: "0.1.0",
    protocol: { min: 1, max: 1 },
    run: { command: ["bun", bridgeMain] },
    permissions: ["network"],
    provides: { methods: Object.keys(validateConfig(config).endpoints) },
    restart: { policy: "on-failure", maxRestarts: 5, windowSec: 300 },
  };
}
