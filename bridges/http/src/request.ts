// Sends one configured HTTP request: templates filled, secrets read from files, response size-capped.
import { homedir } from "node:os";
import { join } from "node:path";
import { ErrorCode, RpcError } from "@me/protocol";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  buildBody,
  buildPlainHeaders,
  buildUrl,
  checkParams,
  type EndpointSpec,
  type HeaderSpec,
  type HttpConfig,
  type SecretHeader,
} from "./config.ts";

export interface HttpResult {
  status: number;
  ok: boolean;
  contentType: string | null;
  /** Set for 3xx responses; redirects are never followed (they could carry secret headers elsewhere). */
  location?: string;
  body: unknown;
  /** Set when a text body was cut at maxBytes. */
  truncated?: boolean;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

function expandHome(p: string) {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** Reads a secret header's file. Errors name the header and path, never the content. */
async function secretValue(name: string, h: SecretHeader): Promise<string> {
  const path = expandHome(h.file);
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    throw new RpcError(-32603, `secret file for header ${name} is unreadable: ${path}`);
  }
  const secret = text.trim();
  if (!secret || /[\r\n\0]/.test(secret)) throw new RpcError(-32603, `secret file for header ${name} must hold one non-empty line: ${path}`);
  return (h.format ?? "{secret}").replace("{secret}", () => secret);
}

/** Reads at most `limit` bytes; stops reading (and cancels the body) past it. */
async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(), truncated: false };
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let kept = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const take = value.subarray(0, limit - kept);
    parts.push(take);
    kept += take.length;
    if (take.length < value.length) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return { bytes: Buffer.concat(parts), truncated };
}

export async function sendRequest(
  name: string,
  config: HttpConfig,
  endpoint: EndpointSpec,
  rawParams: unknown,
  opts: RequestOptions = {},
): Promise<HttpResult> {
  let values;
  let url: URL;
  let headers: Record<string, string>;
  let body: ReturnType<typeof buildBody>;
  const allHeaders: Record<string, HeaderSpec> = { ...(config.headers ?? {}), ...(endpoint.headers ?? {}) };
  try {
    values = checkParams(endpoint.params, rawParams);
    url = buildUrl(config, endpoint, values);
    headers = buildPlainHeaders(allHeaders, values);
    body = buildBody(endpoint, values);
  } catch (err) {
    throw new RpcError(-32602, `${name}: ${(err as Error).message}`);
  }
  for (const [h, spec] of Object.entries(allHeaders)) {
    if (typeof spec !== "string") headers[h] = await secretValue(h, spec);
  }
  if (body && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = body.contentType;

  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = endpoint.maxBytes ?? config.maxBytes ?? DEFAULT_MAX_BYTES;
  if (opts.signal?.aborted) throw new RpcError(ErrorCode.Cancelled, `${name}: cancelled`);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const stopped = (err: unknown) => {
    if (timeout.aborted) return new RpcError(ErrorCode.Timeout, `${name}: timed out after ${timeoutMs}ms`);
    if (opts.signal?.aborted) return new RpcError(ErrorCode.Cancelled, `${name}: cancelled`);
    return new RpcError(-32603, `${name}: request failed: ${(err as Error).message}`);
  };

  let res: Response;
  let raw: { bytes: Uint8Array; truncated: boolean };
  try {
    res = await fetch(url, { method: endpoint.method ?? "GET", headers, body: body?.body, redirect: "manual", signal });
    raw = await readCapped(res.body, maxBytes);
  } catch (err) {
    throw stopped(err);
  }

  const text = new TextDecoder().decode(raw.bytes);
  const result: HttpResult = { status: res.status, ok: res.ok, contentType: res.headers.get("content-type"), body: text };
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) result.location = location;
  if (endpoint.parse === "json") {
    if (raw.truncated) {
      throw new RpcError(-32603, `${name}: response exceeds maxBytes (${maxBytes}); cannot parse JSON`, { status: res.status, maxBytes });
    }
    if (!text.trim()) result.body = null;
    else {
      try {
        result.body = JSON.parse(text);
      } catch {
        // An error page is often HTML or plain text; keep it as a result rather than hide it.
        if (res.ok) throw new RpcError(-32603, `${name}: response is not valid JSON`, { status: res.status, body: text.slice(0, 8192) });
      }
    }
  } else if (raw.truncated) {
    result.truncated = true;
  }
  if (!res.ok && endpoint.failOnError) throw new RpcError(-32603, `${name}: HTTP ${res.status}`, result as any);
  return result;
}
