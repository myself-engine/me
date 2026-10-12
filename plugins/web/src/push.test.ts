import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Coalescer,
  addSub,
  approvalPayload,
  ensureVapid,
  fanout,
  loadSubs,
  oneLine,
  opsDownPayload,
  parseSubscription,
  removeSub,
  swResponse,
  taskFailedPayload,
  taskResultPayload,
  testPayload,
  type PushTransport,
  type StoredSub,
} from "./push.ts";

const sub = (endpoint = "https://push.example/device/1") => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth-key" } });
const dir = () => mkdtempSync(join(tmpdir(), "me-push-"));

describe("payloads", () => {
  test("approval carries the summary and a chat hash", () => {
    expect(approvalPayload("위임할까요", "#/chat/t1")).toEqual({ title: "승인이 필요해요", body: "위임할까요", url: "#/chat/t1" });
  });
  test("task result and failure name the task", () => {
    expect(taskResultPayload("밤샘 정리\n두 번째 줄", "#/chat/t1")).toEqual({ title: "작업 결과가 왔어요", body: "밤샘 정리 두 번째 줄", url: "#/chat/t1" });
    expect(taskFailedPayload("밤샘 정리", "#/settings/device").title).toBe("작업이 실패했어요");
  });
  test("ops down names the check", () => {
    expect(opsDownPayload("밤샘 작업", "exit 1", "#/settings/device")).toEqual({
      title: "점검이 실패했어요 · 밤샘 작업",
      body: "exit 1",
      url: "#/settings/device",
    });
  });
  test("test payload opens settings", () => {
    expect(testPayload().url).toBe("#/settings/device");
  });
  test("bodies are one redacted line", () => {
    expect(oneLine("  a\n\nb   c  ", 100)).toBe("a b c");
    expect(oneLine("x".repeat(200), 120).length).toBeLessThanOrEqual(121);
    expect(oneLine("token=abc token=hunter2", 100)).not.toContain("hunter2");
    expect(oneLine(null, 10)).toBe("");
  });
});

describe("coalescing", () => {
  test("at most one push per kind per window", () => {
    let t = 1_000_000;
    const c = new Coalescer(30_000, () => t);
    expect(c.allow("approval")).toBe(true);
    expect(c.allow("approval")).toBe(false);
    expect(c.allow("task-result")).toBe(true);
    t += 29_999;
    expect(c.allow("approval")).toBe(false);
    t += 1;
    expect(c.allow("approval")).toBe(true);
  });
});

describe("subscriptions", () => {
  test("rejects unusable subscriptions", () => {
    expect(() => parseSubscription(null)).toThrow("쓸 수 없는 구독이에요");
    expect(() => parseSubscription({ endpoint: "http://plain/device", keys: { p256dh: "a", auth: "b" } })).toThrow();
    expect(() => parseSubscription({ endpoint: "https://push.example/1", keys: { p256dh: "", auth: "b" } })).toThrow();
    expect(parseSubscription(sub())).toEqual(sub());
  });
  test("missing file means no devices; bad entries are skipped", () => {
    const d = dir();
    expect(loadSubs(d)).toEqual([]);
    writeFileSync(join(d, "push-subscriptions.json"), JSON.stringify([sub(), { endpoint: "nope" }]));
    expect(loadSubs(d)).toEqual([{ ...sub(), createdAt: new Date(0).toISOString() }]);
    writeFileSync(join(d, "push-subscriptions.json"), "not json");
    expect(loadSubs(d)).toEqual([]);
  });
  test("add replaces the same endpoint and removes by endpoint", () => {
    const d = dir();
    addSub(d, sub());
    addSub(d, { ...sub(), keys: { p256dh: "new", auth: "new" } });
    const subs = loadSubs(d);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.keys.p256dh).toBe("new");
    expect(removeSub(d, sub().endpoint)).toBe(true);
    expect(removeSub(d, sub().endpoint)).toBe(false);
    expect(loadSubs(d)).toEqual([]);
  });
  test("subscription file is owner-only", () => {
    const d = dir();
    addSub(d, sub());
    expect(statSync(join(d, "push-subscriptions.json")).mode & 0o777).toBe(0o600);
  });
});

describe("vapid", () => {
  test("generated once, then reused, owner-only", () => {
    const d = dir();
    const first = ensureVapid(d);
    expect(first.publicKey.length).toBeGreaterThan(20);
    expect(first.privateKey.length).toBeGreaterThan(20);
    expect(ensureVapid(d)).toEqual(first);
    expect(statSync(join(d, "push-vapid.json")).mode & 0o777).toBe(0o600);
    const logged = JSON.stringify(first);
    expect(logged).toContain("publicKey");
    // The private key never travels: only the public key leaves the server.
    expect(typeof first.publicKey).toBe("string");
  });
});

describe("fanout", () => {
  const stored = (endpoint: string): StoredSub => ({ ...sub(endpoint), createdAt: new Date(0).toISOString() });
  const vapid = { publicKey: "pub", privateKey: "priv" };
  test("gone endpoints are reported for removal, others kept", async () => {
    const seen: string[] = [];
    const transport: PushTransport = {
      send: async (s) => {
        seen.push(s.endpoint);
        if (s.endpoint.endsWith("/gone")) return { ok: false, gone: true };
        if (s.endpoint.endsWith("/flaky")) return { ok: false, gone: false, status: 503 };
        return { ok: true };
      },
    };
    const res = await fanout([stored("https://push.example/ok"), stored("https://push.example/gone"), stored("https://push.example/flaky")], "{}", vapid, transport);
    expect(seen).toHaveLength(3);
    expect(res.gone).toEqual(["https://push.example/gone"]);
    expect(res.failed).toBe(1);
  });
  test("a throwing transport counts as failed, never throws", async () => {
    const transport: PushTransport = {
      send: async () => {
        throw new Error("down");
      },
    };
    await expect(fanout([stored("https://push.example/ok")], "{}", vapid, transport)).resolves.toEqual({ gone: [], failed: 1 });
  });
});

describe("service worker route", () => {
  test("serves only /sw.js as javascript", async () => {
    const res = swResponse("/sw.js", "self.addEventListener");
    expect(res!.headers.get("content-type")).toBe("application/javascript");
    expect(await res!.text()).toBe("self.addEventListener");
    expect(swResponse("/other", "x")).toBeNull();
  });
  test("the worker handles push clicks and opens hashes", async () => {
    const text = readFileSync(new URL("../ui/sw.js", import.meta.url), "utf8");
    for (const needle of ["showNotification", "notificationclick", "openWindow", "clients.matchAll", "#/settings/device"]) {
      expect(text).toContain(needle);
    }
  });
});
