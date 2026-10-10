// Who may talk to the web plugin. Pure: no plugin, no server, so the Host/Origin/identity matrix is testable.
//
// Two kinds of requests reach 127.0.0.1:<port>:
//   local   — Host is localhost/127.0.0.1 (or an extraHosts entry). Current rules; identity headers are never read,
//             because anything on this machine could forge them.
//   tailnet — Host is the `tailscale serve` hostname. Serve strips client-supplied Tailscale-User-* headers and sets
//             its own, so the login it sends must be in allowedLogins or the request is 403.
// Caveat: serve proxies to 127.0.0.1, so a local process can also send the tailnet Host plus a forged login.
// That gains nothing over the local path it already has.

export interface TailscaleConfig {
  enabled: boolean;
  /** `<machine>.<tailnet>.ts.net`, no trailing dot. */
  hostname: string | null;
  allowedLogins: string[];
  /** HTTPS port `tailscale serve` listens on; 443 unless another handler already owns it. */
  httpsPort: number;
}

export interface AccessConfig {
  port: number;
  extraHosts: string[];
  extraOrigins: string[];
  tailscale: TailscaleConfig;
}

export interface Viewer {
  login: string;
  name: string;
}

export type Access =
  | { kind: "local" }
  | { kind: "tailnet"; viewer: Viewer }
  | { kind: "forbidden"; reason: string };

/** Normalises pluginConfig.web.tailscale. `detectedHostname` is used when hostname is omitted. */
export function tailscaleConfig(raw: unknown, detectedHostname: string | null = null): TailscaleConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const hostname = typeof c.hostname === "string" && c.hostname ? c.hostname : detectedHostname;
  return {
    enabled: c.enabled === true,
    hostname: hostname ? hostname.replace(/\.$/, "").toLowerCase() : null,
    allowedLogins: Array.isArray(c.allowedLogins) ? c.allowedLogins.filter((l): l is string => typeof l === "string").map((l) => l.toLowerCase()) : [],
    httpsPort: typeof c.httpsPort === "number" ? c.httpsPort : 443,
  };
}

/** True when the config asks for tailscale but gives no hostname, so it must be read from `tailscale status --json`. */
export function needsHostnameDetection(raw: unknown): boolean {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return c.enabled === true && !(typeof c.hostname === "string" && c.hostname);
}

/** Self.DNSName from `tailscale status --json` output, trailing dot removed. */
export function hostnameFromStatus(statusJson: string): string | null {
  try {
    const name = JSON.parse(statusJson)?.Self?.DNSName;
    return typeof name === "string" && name ? name.replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

export function localHosts(cfg: AccessConfig): Set<string> {
  return new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`, ...cfg.extraHosts]);
}

export function localOrigins(cfg: AccessConfig): Set<string> {
  return new Set([...localHosts(cfg)].map((h) => `http://${h}`).concat(cfg.extraOrigins));
}

function tailnetActive(cfg: AccessConfig): string | null {
  return cfg.tailscale.enabled && cfg.tailscale.hostname ? cfg.tailscale.hostname : null;
}

export function tailnetHosts(cfg: AccessConfig): Set<string> {
  const h = tailnetActive(cfg);
  if (!h) return new Set();
  const p = cfg.tailscale.httpsPort;
  return new Set(p === 443 ? [h, `${h}:443`] : [`${h}:${p}`]);
}

export function tailnetOrigin(cfg: AccessConfig): string | null {
  const h = tailnetActive(cfg);
  if (!h) return null;
  const p = cfg.tailscale.httpsPort;
  return p === 443 ? `https://${h}` : `https://${h}:${p}`;
}

/** RFC 2047 encoded-word decoding (serve Q-encodes non-ASCII values, e.g. a Korean display name). */
export function decodeHeaderValue(v: string): string {
  return v.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
    let bytes: Uint8Array;
    if (enc.toUpperCase() === "B") {
      bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    } else {
      const out: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (ch === "_") out.push(0x20);
        else if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
          out.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else out.push(ch.charCodeAt(0));
      }
      bytes = Uint8Array.from(out);
    }
    try {
      return new TextDecoder(charset, { fatal: true }).decode(bytes);
    } catch {
      return whole;
    }
  });
}

/** Classifies a request by its Host header. Identity headers are only read for the tailnet Host. */
export function classify(headers: Headers, cfg: AccessConfig): Access {
  const host = (headers.get("host") ?? "").toLowerCase();
  if (localHosts(cfg).has(host)) return { kind: "local" };
  if (!tailnetHosts(cfg).has(host)) return { kind: "forbidden", reason: "forbidden host" };
  const login = decodeHeaderValue(headers.get("tailscale-user-login") ?? "").trim();
  if (!login) return { kind: "forbidden", reason: "missing tailscale identity" };
  if (!cfg.tailscale.allowedLogins.includes(login.toLowerCase())) return { kind: "forbidden", reason: "login not allowed" };
  const name = decodeHeaderValue(headers.get("tailscale-user-name") ?? "").trim();
  return { kind: "tailnet", viewer: { login, name: name || login } };
}

/** Origin check for the WebSocket: each kind of request must come from its own origin. */
export function originOk(headers: Headers, access: Access, cfg: AccessConfig): boolean {
  const o = headers.get("origin");
  if (o === null) return false;
  if (access.kind === "local") return localOrigins(cfg).has(o);
  if (access.kind === "tailnet") return o.toLowerCase() === tailnetOrigin(cfg);
  return false;
}

/** The viewer bootstrap reports: null for local requests. */
export function viewerOf(access: Access): Viewer | null {
  return access.kind === "tailnet" ? access.viewer : null;
}
