// Scheduled runs: pure job validation and next-due computation. No I/O, so the
// runner (app/service.ts) and the tests drive it with an explicit clock and timezone.
// All wall-clock math happens in the Mac's local timezone (config `timezone`,
// defaulting to the system zone). DST gaps resolve by skipping to the next valid
// day; ambiguous times take the first occurrence.

export type AccessMode = "read" | "project" | "full";
export type WhenKind = "daily" | "weekdays" | "weekly" | "cron";
export type DeliverTarget = "web" | "discord" | "slack";
export type RunState = "started" | "done" | "failed" | "skipped" | "missed";

export interface When {
  kind: WhenKind;
  /** "HH:MM" for daily, weekdays, weekly. */
  time?: string;
  /** 0 (Sunday) to 6 (Saturday) for weekly. */
  weekday?: number;
  /** Five-field cron for kind "cron" (minute hour dom month dow). */
  cron?: string;
}

export interface Job {
  id: string;
  name: string;
  prompt: string;
  project?: string;
  access: AccessMode;
  when: When;
  deliver: DeliverTarget[];
  enabled: boolean;
  /** Stable head thread for this job, set on the first run. */
  threadId?: string;
  createdAt: string;
  updatedAt: string;
  /** True for jobs from pluginConfig (read-only: add/update/remove refuse them). */
  fromConfig?: boolean;
}

export interface Run {
  id: string;
  jobId: string;
  /** ISO instant the run was due (or fired, for runNow). */
  at: string;
  state: RunState;
  threadId: string;
  messageId?: string;
  error?: string;
  delivered?: boolean;
}

export interface ScheduleConfig {
  jobs: Job[];
  allowUnattendedWrite: boolean;
  timezone: string;
  tickSec: number;
  missGraceSec: number;
  chatTimeoutMs: number;
  retryDelaysMs: number[];
}

export const SUMMARY_CHARS = 600;

/** First 600 chars of a reply, for messenger delivery. Redaction happens in the service. */
export function summarize(text: string): string {
  return text.slice(0, SUMMARY_CHARS);
}

const str = (v: unknown) => typeof v === "string" ? v : null;

export function parseTime(raw: unknown): { h: number; m: number } {
  if (typeof raw !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
    throw new Error(`when.time은 "HH:MM"이어야 해요 (받은 값: ${JSON.stringify(raw)})`);
  }
  return { h: Number(raw.slice(0, 2)), m: Number(raw.slice(3, 5)) };
}

// ---------------------------------------------------------------------------
// Cron: five fields (minute hour dom month dow). Supports *, */n, a-b, a-b/n,
// lists. Day-of-month and day-of-week match OR-style, like cron.
// ---------------------------------------------------------------------------

export interface CronFields {
  minute: Set<number> | null;
  hour: Set<number> | null;
  dom: Set<number> | null; // null = *
  month: Set<number> | null; // null = * (1-12)
  dow: Set<number> | null; // null = * (0-6, 7 = Sunday)
}

export function parseCron(raw: unknown): CronFields {
  if (typeof raw !== "string") throw new Error("when.cron은 다섯 칸 문자열이어야 해요 (예: \"30 9 * * 1-5\")");
  const fields = raw.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`when.cron은 다섯 칸이어야 해요 (받은 칸: ${fields.length})`);
  const num = (f: string, min: number, max: number, name: string): Set<number> | null => {
    if (f === "*") return null;
    const out = new Set<number>();
    for (const part of f.split(",")) {
      let range = part;
      let step = 1;
      const slash = part.indexOf("/");
      if (slash >= 0) {
        range = part.slice(0, slash);
        step = Number(part.slice(slash + 1));
        if (!Number.isInteger(step) || step < 1) throw new Error(`cron ${name}의 간격이 이상해요: ${part}`);
      }
      let lo: number;
      let hi: number;
      if (range === "*") {
        lo = min;
        hi = max;
      } else {
        const dash = range.indexOf("-");
        if (dash >= 0) {
          lo = Number(range.slice(0, dash));
          hi = Number(range.slice(dash + 1));
        } else {
          lo = hi = Number(range);
        }
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
        throw new Error(`cron ${name}이 범위를 벗어났어요: ${part} (가능: ${min}-${max})`);
      }
      for (let v = lo; v <= hi; v += step) out.add(v);
    }
    if (!out.size) throw new Error(`cron ${name}이 비었어요`);
    return out;
  };
  const dow = num(fields[4]!.replace(/\b7\b/g, "0"), 0, 6, "요일");
  return { minute: num(fields[0]!, 0, 59, "분"), hour: num(fields[1]!, 0, 23, "시"), dom: num(fields[2]!, 1, 31, "일"), month: num(fields[3]!, 1, 12, "월"), dow };
}

export interface WallParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in the given timezone. */
export function wallParts(ms: number, tz: string): WallParts {
  const p: Record<string, number> = {};
  for (const part of dtf(tz).formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute! };
}

/** Timezone offset (wall minus UTC) in ms at an instant. */
function tzOffsetMs(utcMs: number, tz: string): number {
  return Date.UTC(wallParts(utcMs, tz).y, wallParts(utcMs, tz).mo - 1, wallParts(utcMs, tz).d, wallParts(utcMs, tz).h, wallParts(utcMs, tz).mi) -
    Math.floor(utcMs / 60000) * 60000;
}

/**
 * Wall-clock time to an instant. Returns null when the wall time does not exist
 * (a DST spring-forward gap); ambiguous fall-back times take the first occurrence.
 */
export function wallToUtc(w: WallParts, tz: string): number | null {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const first = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(first, tz);
  const back = wallParts(second, tz);
  if (back.y !== w.y || back.mo !== w.mo || back.d !== w.d || back.h !== w.h || back.mi !== w.mi) return null;
  return second;
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Adds days in wall-calendar space (noon-anchored, so DST never shifts the date). */
function addDays(w: WallParts, n: number): WallParts {
  const d = new Date(Date.UTC(w.y, w.mo - 1, w.d + n, 12));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: w.h, mi: w.mi };
}

/** Sunday = 0 like Date.getDay. Noon-anchored so DST never shifts the weekday. */
function weekdayOf(w: WallParts): number {
  return new Date(Date.UTC(w.y, w.mo - 1, w.d, 12)).getUTCDay();
}

function validateWhen(when: When): void {
  if (when.kind === "cron") {
    if (when.cron === undefined) throw new Error(`cron 종류는 when.cron이 있어야 해요`);
    parseCron(when.cron);
    return;
  }
  if (when.kind !== "daily" && when.kind !== "weekdays" && when.kind !== "weekly") {
    throw new Error(`when.kind는 daily, weekdays, weekly, cron 중 하나여야 해요`);
  }
  if (when.time === undefined) throw new Error(`${when.kind} 종류는 when.time("HH:MM")이 있어야 해요`);
  parseTime(when.time);
  if (when.kind === "weekly") {
    if (!Number.isInteger(when.weekday) || (when.weekday as number) < 0 || (when.weekday as number) > 6) {
      throw new Error("weekly 종류는 weekday(0=일요일 … 6=토요일)가 있어야 해요");
    }
  }
}

const ACCESSES: AccessMode[] = ["read", "project", "full"];
const DELIVERS: DeliverTarget[] = ["web", "discord", "slack"];

/** Validates one job object (config or runtime). Throws a Korean error on problems. */
export function parseJob(raw: Record<string, unknown>, opts: { fromConfig: boolean }): Job {
  const id = str(raw.id);
  if (!id) throw new Error("job id가 비었어요");
  const name = str(raw.name)?.trim();
  if (!name) throw new Error(`job ${id}: name이 비었어요`);
  const prompt = str(raw.prompt)?.trim();
  if (!prompt) throw new Error(`job ${id}: prompt가 비었어요`);
  const access = raw.access ?? "read";
  if (!ACCESSES.includes(access as AccessMode)) throw new Error(`job ${id}: access는 read, project, full 중 하나여야 해요`);
  const when = raw.when as When | undefined;
  if (!when || typeof when !== "object") throw new Error(`job ${id}: when이 있어야 해요`);
  validateWhen(when);
  const deliver = raw.deliver ?? ["web"];
  if (!Array.isArray(deliver) || !deliver.length || !deliver.every((d) => DELIVERS.includes(d as DeliverTarget))) {
    throw new Error(`job ${id}: deliver는 web, discord, slack의 조합이어야 해요`);
  }
  const project = str(raw.project ?? null) ?? undefined;
  const now = new Date().toISOString();
  return {
    id,
    name,
    prompt,
    ...(project ? { project } : {}),
    access: access as AccessMode,
    when: { kind: when.kind, ...(when.time !== undefined ? { time: when.time } : {}), ...(when.weekday !== undefined ? { weekday: when.weekday } : {}), ...(when.cron !== undefined ? { cron: when.cron } : {}) },
    deliver: [...new Set(deliver)] as DeliverTarget[],
    enabled: raw.enabled !== false,
    ...(typeof raw.threadId === "string" && raw.threadId ? { threadId: raw.threadId } : {}),
    createdAt: str(raw.createdAt) ?? now,
    updatedAt: now,
    ...(opts.fromConfig ? { fromConfig: true as const } : {}),
  };
}

export function parseScheduleConfig(raw: Record<string, unknown>): ScheduleConfig {
  const jobsRaw = raw.jobs ?? [];
  if (!Array.isArray(jobsRaw)) throw new Error("schedule: jobs는 목록이어야 해요");
  const ids = new Set<string>();
  const jobs = jobsRaw.map((j) => {
    if (!j || typeof j !== "object") throw new Error("schedule: jobs 항목은 객체여야 해요");
    const job = parseJob(j as Record<string, unknown>, { fromConfig: true });
    if (ids.has(job.id)) throw new Error(`schedule: job id가 겹쳐요: ${job.id}`);
    ids.add(job.id);
    return job;
  });
  const timezone = typeof raw.timezone === "string" && raw.timezone ? raw.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`schedule: timezone이 이상해요: ${timezone}`);
  }
  const tickSec = typeof raw.tickSec === "number" ? Math.max(5, Math.floor(raw.tickSec)) : 30;
  const missGraceSec = typeof raw.missGraceSec === "number" ? Math.max(0, Math.floor(raw.missGraceSec)) : 60;
  const chatTimeoutMs = typeof raw.chatTimeoutMs === "number" ? raw.chatTimeoutMs : 2_000_000;
  const retryDelaysMs = Array.isArray(raw.retryDelaysMs) ? raw.retryDelaysMs : [5_000, 30_000];
  return { jobs, allowUnattendedWrite: raw.allowUnattendedWrite === true, timezone, tickSec, missGraceSec, chatTimeoutMs, retryDelaysMs };
}

// ---------------------------------------------------------------------------
// Next / previous due instants.
// ---------------------------------------------------------------------------

function cronMatches(cron: CronFields, w: WallParts): boolean {
  if (cron.minute && !cron.minute.has(w.mi)) return false;
  if (cron.hour && !cron.hour.has(w.h)) return false;
  if (cron.month && !cron.month.has(w.mo)) return false;
  const domStar = cron.dom === null;
  const dowStar = cron.dow === null;
  // Standard cron: a `*` side defers to the other; two restricted sides match either.
  if (domStar && dowStar) return true;
  if (domStar) return cron.dow!.has(weekdayOf(w));
  if (dowStar) return cron.dom!.has(w.d);
  return cron.dom!.has(w.d) || cron.dow!.has(weekdayOf(w));
}

function advanceMinute(w: WallParts): WallParts {
  let { y, mo, d, h, mi } = w;
  mi++;
  if (mi > 59) {
    mi = 0;
    h++;
  }
  if (h > 23) {
    h = 0;
    d++;
    if (d > daysInMonth(y, mo)) {
      d = 1;
      mo++;
    }
    if (mo > 12) {
      mo = 1;
      y++;
    }
  }
  return { y, mo, d, h, mi };
}

/** Next due instant strictly after fromMs, or null when none within a year. */
export function nextDue(when: When, fromMs: number, tz: string): number | null {
  if (when.kind === "cron") {
    const cron = parseCron(when.cron);
    const start = Math.floor(fromMs / 60000) * 60000 + 60000;
    let w = wallParts(start, tz);
    // A cron matching every minute still lands within the cap; exotic dates (Feb 29) need the full year.
    for (let i = 0; i < 527040; i++) {
      if (cronMatches(cron, w)) {
        const c = wallToUtc(w, tz);
        if (c !== null && c > fromMs) return c;
      }
      w = advanceMinute(w);
    }
    return null;
  }
  const t = parseTime(when.time);
  const base = wallParts(fromMs, tz);
  for (let add = 0; add < 10; add++) {
    const day = addDays({ ...base, h: t.h, mi: t.m }, add);
    const dow = weekdayOf(day);
    if (when.kind === "weekdays" && (dow === 0 || dow === 6)) continue;
    if (when.kind === "weekly" && dow !== when.weekday) continue;
    const c = wallToUtc(day, tz);
    // A DST gap makes the wall time vanish; the run waits for the next valid day.
    if (c === null) continue;
    if (c > fromMs) return c;
  }
  return null;
}

/** Most recent due instant strictly before beforeMs and within lookbackMs, or null. */
export function prevDue(when: When, beforeMs: number, tz: string, lookbackMs = 8 * 86400_000): number | null {
  if (when.kind === "cron") {
    const cron = parseCron(when.cron);
    const start = Math.floor((beforeMs - 1) / 60000) * 60000;
    let w = wallParts(start, tz);
    const steps = Math.min(Math.floor(lookbackMs / 60000), 11520);
    for (let i = 0; i <= steps; i++) {
      if (cronMatches(cron, w)) {
        const c = wallToUtc(w, tz);
        if (c !== null && c < beforeMs && beforeMs - c <= lookbackMs) return c;
      }
      // Step back one minute arithmetically.
      let { y, mo, d, h, mi } = w;
      mi--;
      if (mi < 0) {
        mi = 59;
        h--;
      }
      if (h < 0) {
        h = 23;
        d--;
        if (d < 1) {
          mo--;
          if (mo < 1) {
            mo = 12;
            y--;
          }
          d = daysInMonth(y, mo);
        }
      }
      w = { y, mo, d, h, mi };
    }
    return null;
  }
  const t = parseTime(when.time);
  const base = wallParts(beforeMs - 1, tz);
  for (let back = 0; back < 10; back++) {
    const day = addDays({ ...base, h: t.h, mi: t.m }, -back);
    const dow = weekdayOf(day);
    if (when.kind === "weekdays" && (dow === 0 || dow === 6)) continue;
    if (when.kind === "weekly" && dow !== when.weekday) continue;
    const c = wallToUtc(day, tz);
    if (c === null) continue;
    if (c < beforeMs && beforeMs - c <= lookbackMs) return c;
    if (beforeMs - c > lookbackMs) return null;
  }
  return null;
}

/** Every due instant in (afterMs, upToMs], oldest first, capped. Used for missed-on-startup. */
export function duesBetween(when: When, afterMs: number, upToMs: number, tz: string, cap = 20): number[] {
  const out: number[] = [];
  let cursor = afterMs;
  while (out.length < cap) {
    const d = nextDue(when, cursor, tz);
    if (d === null || d > upToMs) break;
    out.push(d);
    cursor = d;
  }
  return out;
}
