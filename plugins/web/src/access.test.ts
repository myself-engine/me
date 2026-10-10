import { describe, expect, test } from "bun:test";
import { type AccessConfig, classify, decodeHeaderValue, hostnameFromStatus, originOk, tailscaleConfig, viewerOf } from "./access.ts";
import { manifest, pwaResponse } from "./pwa.ts";

const TS = "mac.tail0.ts.net";

const cfg = (tailscale: Record<string, unknown> = { enabled: true, hostname: TS, allowedLogins: ["me@example.com"] }): AccessConfig => ({
  port: 7420,
  extraHosts: [],
  extraOrigins: [],
  tailscale: tailscaleConfig(tailscale),
});

const h = (o: Record<string, string>) => new Headers(o);

describe("host / identity matrix", () => {
  test("localhost host keeps working and has no viewer", () => {
    for (const host of ["127.0.0.1:7420", "localhost:7420"]) {
      const a = classify(h({ host }), cfg());
      expect(a).toEqual({ kind: "local" });
      expect(viewerOf(a)).toBeNull();
    }
  });

  test("localhost host with forged identity headers: identity ignored", () => {
    const a = classify(h({ host: "127.0.0.1:7420", "tailscale-user-login": "me@example.com", "tailscale-user-name": "Me" }), cfg());
    expect(a).toEqual({ kind: "local" });
    expect(viewerOf(a)).toBeNull();
  });

  test("tailnet host without identity header → forbidden", () => {
    expect(classify(h({ host: TS }), cfg()).kind).toBe("forbidden");
  });

  test("tailnet host with an allowed login → ok, viewer reported", () => {
    const a = classify(h({ host: TS, "tailscale-user-login": "Me@Example.com", "tailscale-user-name": "Me" }), cfg());
    expect(a.kind).toBe("tailnet");
    expect(viewerOf(a)).toEqual({ login: "Me@Example.com", name: "Me" });
    expect(classify(h({ host: `${TS}:443`, "tailscale-user-login": "me@example.com" }), cfg()).kind).toBe("tailnet");
  });

  test("tailnet host with another login → forbidden", () => {
    expect(classify(h({ host: TS, "tailscale-user-login": "other@example.com" }), cfg()).kind).toBe("forbidden");
  });

  test("tailscale disabled → tailnet host forbidden even with an allowed login", () => {
    const off = cfg({ enabled: false, hostname: TS, allowedLogins: ["me@example.com"] });
    expect(classify(h({ host: TS, "tailscale-user-login": "me@example.com" }), off).kind).toBe("forbidden");
    expect(classify(h({ host: TS, "tailscale-user-login": "me@example.com" }), cfg({})).kind).toBe("forbidden");
  });

  test("enabled with no allowed logins forbids everyone on the tailnet", () => {
    const none = cfg({ enabled: true, hostname: TS });
    expect(classify(h({ host: TS, "tailscale-user-login": "me@example.com" }), none).kind).toBe("forbidden");
  });

  test("unknown hosts stay forbidden", () => {
    expect(classify(h({ host: "evil.example:7420" }), cfg()).kind).toBe("forbidden");
    expect(classify(h({ host: "other.tail0.ts.net", "tailscale-user-login": "me@example.com" }), cfg()).kind).toBe("forbidden");
    expect(classify(h({}), cfg()).kind).toBe("forbidden");
  });

  test("non-default https port only accepts host:port", () => {
    const c = cfg({ enabled: true, hostname: TS, allowedLogins: ["me@example.com"], httpsPort: 8443 });
    expect(classify(h({ host: `${TS}:8443`, "tailscale-user-login": "me@example.com" }), c).kind).toBe("tailnet");
    expect(classify(h({ host: TS, "tailscale-user-login": "me@example.com" }), c).kind).toBe("forbidden");
  });
});

describe("origin", () => {
  const ok = (headers: Record<string, string>, c = cfg()) => originOk(h(headers), classify(h(headers), c), c);
  const id = { "tailscale-user-login": "me@example.com" };

  test("local requests need a local origin", () => {
    expect(ok({ host: "127.0.0.1:7420", origin: "http://127.0.0.1:7420" })).toBe(true);
    expect(ok({ host: "127.0.0.1:7420", origin: `https://${TS}` })).toBe(false);
    expect(ok({ host: "127.0.0.1:7420" })).toBe(false);
  });

  test("tailnet requests need the tailnet https origin", () => {
    expect(ok({ host: TS, origin: `https://${TS}`, ...id })).toBe(true);
    expect(ok({ host: TS, origin: "http://127.0.0.1:7420", ...id })).toBe(false);
    expect(ok({ host: TS, origin: `http://${TS}`, ...id })).toBe(false);
    expect(ok({ host: TS, origin: `https://${TS}` })).toBe(false); // no identity → forbidden first
  });
});

describe("config", () => {
  test("hostname is auto-detected from tailscale status when omitted, trailing dot stripped", () => {
    const detected = hostnameFromStatus(JSON.stringify({ Self: { DNSName: "Mac.tail0.ts.net." } }));
    expect(detected).toBe("Mac.tail0.ts.net");
    expect(tailscaleConfig({ enabled: true }, detected).hostname).toBe("mac.tail0.ts.net");
    expect(tailscaleConfig({ enabled: true, hostname: "x.tail0.ts.net" }, detected).hostname).toBe("x.tail0.ts.net");
    expect(hostnameFromStatus("not json")).toBeNull();
  });

  test("enabled without any hostname leaves tailnet access off", () => {
    const c = cfg({ enabled: true, allowedLogins: ["me@example.com"] });
    expect(classify(h({ host: TS, "tailscale-user-login": "me@example.com" }), c).kind).toBe("forbidden");
  });
});

describe("decodeHeaderValue", () => {
  test("decodes RFC 2047 Q-encoded names (serve encodes non-ASCII)", () => {
    expect(decodeHeaderValue("=?utf-8?q?=ED=99=8D=EA=B8=B8=EB=8F=99?=")).toBe("홍길동");
    expect(decodeHeaderValue("=?utf-8?q?Jane_Doe?=")).toBe("Jane Doe");
    expect(decodeHeaderValue("plain@example.com")).toBe("plain@example.com");
  });
});

describe("pwa", () => {
  test("manifest is standalone, named me, with svg icons", async () => {
    expect(manifest).toMatchObject({ name: "me", short_name: "me", display: "standalone" });
    const res = pwaResponse("/manifest.webmanifest")!;
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    expect((await res.json()).icons.every((i: any) => i.type === "image/svg+xml")).toBe(true);
    expect(pwaResponse("/icon.svg")!.headers.get("content-type")).toBe("image/svg+xml");
    expect(await pwaResponse("/icon-maskable.svg")!.text()).toStartWith("<svg");
    expect(pwaResponse("/sw.js")).toBeNull();
  });
});
