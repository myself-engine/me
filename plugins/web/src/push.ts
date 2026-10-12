// Web Push with VAPID for phone notifications. The only outbound traffic the
// web plugin makes is POSTs to the browser vendor's push service, and pushes
// only work in a secure context (https over tailscale serve, or localhost).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush from "web-push";
import { redactString } from "@me/redact";

/** Contact for the push services; nothing is ever sent here. */
const VAPID_SUBJECT = "mailto:me@localhost";
const VAPID_FILE = "push-vapid.json";
const SUBS_FILE = "push-subscriptions.json";
/** Bursts collapse: at most one push per kind per window. */
export const COALESCE_MS = 30_000;
/** Bounds the subscription file; the oldest device drops off first. */
const MAX_SUBS = 50;

export type PushKind = "approval" | "task-result" | "task-failed" | "ops-down";

export interface PushPayload {
  title: string;
  body: string;
  /** Hash for the client to open (#/chat/<thread> or #/settings/device). */
  url: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface StoredSub extends PushTarget {
  createdAt: string;
}

function writePrivate(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Loads the VAPID pair, generating and storing it (0600) on first use. */
export function ensureVapid(dir: string): VapidKeys {
  const path = join(dir, VAPID_FILE);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<VapidKeys>;
    if (typeof raw.publicKey === "string" && typeof raw.privateKey === "string") return { publicKey: raw.publicKey, privateKey: raw.privateKey };
  }
  const keys = webpush.generateVAPIDKeys();
  writePrivate(path, JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }));
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

/** Validates a client subscription; throws a Korean error when it is unusable. */
export function parseSubscription(raw: unknown): PushTarget {
  // Direct throws (not a never-helper) so narrowing keeps working below.
  const bad = () => new Error("쓸 수 없는 구독이에요");
  if (!raw || typeof raw !== "object") throw bad();
  const { endpoint, keys } = raw as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || endpoint.length > 2000) throw bad();
  if (!keys || typeof keys !== "object") throw bad();
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (typeof p256dh !== "string" || !p256dh || p256dh.length > 500) throw bad();
  if (typeof auth !== "string" || !auth || auth.length > 500) throw bad();
  return { endpoint, keys: { p256dh, auth } };
}

/** Stored subscriptions; a missing or corrupt file means no devices. */
export function loadSubs(dir: string): StoredSub[] {
  try {
    const raw = JSON.parse(readFileSync(join(dir, SUBS_FILE), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: StoredSub[] = [];
    for (const item of raw) {
      try {
        const sub = parseSubscription(item);
        out.push({ ...sub, createdAt: typeof (item as StoredSub)?.createdAt === "string" ? (item as StoredSub).createdAt : new Date(0).toISOString() });
      } catch {
        // One bad entry must not drop the healthy devices.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function saveSubs(dir: string, subs: StoredSub[]) {
  writePrivate(join(dir, SUBS_FILE), JSON.stringify(subs));
}

/** Adds a device subscription (same endpoint replaces), oldest drops past the cap. */
export function addSub(dir: string, sub: PushTarget, now = () => new Date().toISOString()): StoredSub[] {
  const next = [...loadSubs(dir).filter((s) => s.endpoint !== sub.endpoint), { ...sub, createdAt: now() }];
  next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const capped = next.slice(-MAX_SUBS);
  saveSubs(dir, capped);
  return capped;
}

/** Removes a device subscription; true when one was stored. */
export function removeSub(dir: string, endpoint: string): boolean {
  const subs = loadSubs(dir);
  if (!subs.some((s) => s.endpoint === endpoint)) return false;
  saveSubs(dir, subs.filter((s) => s.endpoint !== endpoint));
  return true;
}

/** One redacted line for a payload; secrets never reach the vendor. */
export function oneLine(value: unknown, max: number): string {
  const line = redactString(String(value ?? ""))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** New kernel approval pending: title "승인이 필요해요", body is the summary. */
export function approvalPayload(summary: unknown, url: string): PushPayload {
  return { title: "승인이 필요해요", body: oneLine(summary, 120) || "확인이 필요해요", url };
}

/** A brgr task sealed or verified: title plus the task's first line. */
export function taskResultPayload(objective: unknown, url: string): PushPayload {
  return { title: "작업 결과가 왔어요", body: oneLine(objective, 120) || "작업 결과가 왔어요", url };
}

/** A brgr task failing. */
export function taskFailedPayload(objective: unknown, url: string): PushPayload {
  return { title: "작업이 실패했어요", body: oneLine(objective, 120) || "작업이 실패했어요", url };
}

/** An ops check turning down. */
export function opsDownPayload(name: unknown, detail: unknown, url: string): PushPayload {
  return { title: `점검이 실패했어요 · ${oneLine(name, 40) || "이름 없음"}`, body: oneLine(detail, 120), url };
}

/** Manual test from settings; skips coalescing. */
export function testPayload(): PushPayload {
  return { title: "시험 알림이에요", body: "이 기기에서 잘 받아요", url: "#/settings/device" };
}

/** Burst gate: at most one push per kind per window. */
export class Coalescer {
  private last = new Map<string, number>();
  constructor(
    private windowMs = COALESCE_MS,
    private now = () => Date.now(),
  ) {}
  allow(kind: string): boolean {
    const t = this.now();
    if (t - (this.last.get(kind) ?? Number.NEGATIVE_INFINITY) < this.windowMs) return false;
    this.last.set(kind, t);
    return true;
  }
}

export type SendResult = { ok: true } | { ok: false; gone: boolean; status?: number };

export interface PushTransport {
  send(sub: PushTarget, text: string, vapid: VapidKeys): Promise<SendResult>;
}

/** Real transport over the vendor push services. Failures carry only a status. */
export const webPushTransport: PushTransport = {
  async send(sub, text, vapid): Promise<SendResult> {
    webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, text, { TTL: 3600 });
      return { ok: true };
    } catch (err) {
      const status = (err as { statusCode?: unknown })?.statusCode;
      if (status === 404 || status === 410) return { ok: false, gone: true };
      return { ok: false, gone: false, ...(typeof status === "number" ? { status } : {}) };
    }
  },
};

export interface FanoutResult {
  /** Endpoints the vendor rejected as gone (caller removes them). */
  gone: string[];
  /** Sends that failed without the endpoint going away. */
  failed: number;
}

/** Sends one payload to every device; never throws, never logs endpoints. */
export async function fanout(subs: StoredSub[], text: string, vapid: VapidKeys, transport: PushTransport): Promise<FanoutResult> {
  const gone: string[] = [];
  let failed = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        const r = await transport.send(sub, text, vapid);
        if (!r.ok && r.gone) gone.push(sub.endpoint);
        else if (!r.ok) failed += 1;
      } catch {
        failed += 1;
      }
    }),
  );
  return { gone, failed };
}

const SW_URL = new URL("../ui/sw.js", import.meta.url);
let swCache: string | null = null;

/** Service worker source, read from the plugin dir (never bundled). */
export async function swText(): Promise<string> {
  if (swCache === null) swCache = await Bun.file(SW_URL).text();
  return swCache;
}

/** Static service worker by path, or null. Separate from pwaResponse. */
export function swResponse(pathname: string, text: string): Response | null {
  if (pathname !== "/sw.js") return null;
  return new Response(text, { headers: { "cache-control": "no-cache", "content-type": "application/javascript" } });
}
