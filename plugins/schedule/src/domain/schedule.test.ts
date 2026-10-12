// Next-due computation: daily, weekdays, weekly, cron, and DST edges. All times are
// fixed instants; expectations are written as UTC and double-checked via wallParts.
import { describe, expect, test } from "bun:test";
import { nextDue, parseCron, parseJob, parseScheduleConfig, parseTime, prevDue, summarize, wallParts, type Job } from "./schedule.ts";

const SEOUL = "Asia/Seoul";
const LA = "America/Los_Angeles";

/** 2026-10-12 is a Monday. */
const MON_08 = Date.UTC(2026, 9, 11, 23, 0); // Mon 08:00 KST
const MON_09 = Date.UTC(2026, 9, 12, 0, 0); // Mon 09:00 KST
const TUE_09 = Date.UTC(2026, 9, 13, 0, 0); // Tue 09:00 KST

describe("parseTime", () => {
  test("accepts HH:MM", () => {
    expect(parseTime("09:30")).toEqual({ h: 9, m: 30 });
  });
  test("rejects bad shapes", () => {
    for (const bad of ["9:30", "24:00", "09:60", "0900", "", null, 930]) {
      expect(() => parseTime(bad)).toThrow();
    }
  });
});

describe("nextDue daily", () => {
  test("later today", () => {
    expect(nextDue({ kind: "daily", time: "09:00" }, MON_08, SEOUL)).toBe(MON_09);
  });
  test("tomorrow once today's time has passed", () => {
    expect(nextDue({ kind: "daily", time: "09:00" }, MON_09, SEOUL)).toBe(TUE_09);
  });
});

describe("nextDue weekdays", () => {
  test("Saturday waits for Monday", () => {
    const satMorning = Date.UTC(2026, 9, 17, 0, 0); // Sat 09:00 KST
    expect(wallParts(satMorning, SEOUL)).toMatchObject({ d: 17, h: 9 });
    // 2026-10-17 is a Saturday; next weekday 09:00 is Mon 2026-10-19 09:00 KST.
    expect(nextDue({ kind: "weekdays", time: "09:00" }, satMorning, SEOUL)).toBe(Date.UTC(2026, 9, 19, 0, 0));
  });
  test("Friday evening goes to Monday", () => {
    const friEvening = Date.UTC(2026, 9, 16, 12, 0); // Fri 21:00 KST
    expect(nextDue({ kind: "weekdays", time: "09:00" }, friEvening, SEOUL)).toBe(Date.UTC(2026, 9, 19, 0, 0));
  });
});

describe("nextDue weekly", () => {
  test("Wednesday waits for Friday", () => {
    const wed = Date.UTC(2026, 9, 14, 3, 0); // Wed 12:00 KST
    expect(nextDue({ kind: "weekly", time: "09:00", weekday: 5 }, wed, SEOUL)).toBe(Date.UTC(2026, 9, 16, 0, 0));
  });
  test("after Friday's slot waits a full week", () => {
    const friLate = Date.UTC(2026, 9, 16, 1, 0); // Fri 10:00 KST
    expect(nextDue({ kind: "weekly", time: "09:00", weekday: 5 }, friLate, SEOUL)).toBe(Date.UTC(2026, 9, 23, 0, 0));
  });
});

describe("nextDue cron", () => {
  test("fixed time on weekdays", () => {
    // Mon 09:00 KST; "30 9 * * 1-5" fires Mon 09:30 KST = 00:30 UTC.
    expect(nextDue({ kind: "cron", cron: "30 9 * * 1-5" }, Date.UTC(2026, 9, 12, 0, 0), SEOUL)).toBe(Date.UTC(2026, 9, 12, 0, 30));
  });
  test("step values", () => {
    // 09:07 KST; */15 fires at 09:15 KST = 00:15 UTC.
    expect(nextDue({ kind: "cron", cron: "*/15 * * * *" }, Date.UTC(2026, 9, 11, 23, 7), SEOUL)).toBe(Date.UTC(2026, 9, 11, 23, 15));
  });
  test("rejects bad expressions", () => {
    for (const bad of ["* * * *", "61 * * * *", "*/0 * * * *", "9-3 * * * *", "not a cron"]) {
      expect(() => parseCron(bad)).toThrow();
    }
  });
});

describe("DST edges (America/Los_Angeles)", () => {
  test("spring-forward gap skips to the next valid day", () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00, so 02:30 never happens.
    const before = Date.UTC(2026, 2, 7, 8, 0); // Fri 2026-03-07 00:00 PST
    const due = nextDue({ kind: "daily", time: "02:30" }, before, LA)!;
    const w = wallParts(due, LA);
    // 03-07 02:30 PST still exists and comes first…
    expect(w).toMatchObject({ mo: 3, d: 7, h: 2, mi: 30 });
    // …but from inside the gap day, the run waits for 03-09.
    const gapDay = Date.UTC(2026, 2, 8, 8, 0); // Sun 2026-03-08 00:00 PST
    const due2 = nextDue({ kind: "daily", time: "02:30" }, gapDay, LA)!;
    expect(wallParts(due2, LA)).toMatchObject({ mo: 3, d: 9, h: 2, mi: 30 });
  });
  test("fall-back ambiguity takes the first occurrence", () => {
    // 2026-11-01: 01:00-02:00 happens twice; the run takes the first 01:30 (PDT).
    const before = Date.UTC(2026, 10, 1, 7, 30); // Sun 2026-11-01 00:30 PDT
    const due = nextDue({ kind: "daily", time: "01:30" }, before, LA)!;
    expect(wallParts(due, LA)).toMatchObject({ mo: 11, d: 1, h: 1, mi: 30 });
    expect(due).toBe(Date.UTC(2026, 10, 1, 8, 30)); // 01:30 PDT = 08:30 UTC
  });
  test("cron in the gap waits for the next matching wall minute", () => {
    const gapDay = Date.UTC(2026, 2, 8, 8, 0); // Sun 2026-03-08 00:00 PST
    const due = nextDue({ kind: "cron", cron: "30 2 * * *" }, gapDay, LA)!;
    // 02:30 never occurs on 03-08, so the next match is 03-09 02:30 PDT.
    expect(wallParts(due, LA)).toMatchObject({ mo: 3, d: 9, h: 2, mi: 30 });
  });
});

describe("prevDue", () => {
  test("finds this morning's run", () => {
    expect(prevDue({ kind: "daily", time: "09:00" }, Date.UTC(2026, 9, 12, 3, 0), SEOUL)).toBe(MON_09);
  });
  test("yesterday's run is still the most recent due", () => {
    // Mon 08:00 KST: the most recent 09:00 due is Sun 09:00 KST.
    expect(prevDue({ kind: "daily", time: "09:00" }, MON_08, SEOUL)).toBe(Date.UTC(2026, 9, 11, 0, 0));
  });
});

describe("summarize", () => {
  test("caps at 600 chars", () => {
    expect(summarize("a".repeat(1000))).toHaveLength(600);
    expect(summarize("short")).toBe("short");
  });
});

const base = { id: "j1", name: "아침 브리핑", prompt: "오늘 일정 요약해줘", when: { kind: "daily", time: "09:00" } };

describe("parseJob", () => {
  test("fills defaults", () => {
    const job: Job = parseJob({ ...base }, { fromConfig: false });
    expect(job.access).toBe("read");
    expect(job.deliver).toEqual(["web"]);
    expect(job.enabled).toBe(true);
  });
  test("rejects bad jobs in Korean", () => {
    expect(() => parseJob({ ...base, name: " " }, { fromConfig: false })).toThrow();
    expect(() => parseJob({ ...base, access: "root" }, { fromConfig: false })).toThrow();
    expect(() => parseJob({ ...base, when: { kind: "weekly", time: "09:00" } }, { fromConfig: false })).toThrow();
    expect(() => parseJob({ ...base, deliver: ["sms"] }, { fromConfig: false })).toThrow();
  });
});

describe("parseScheduleConfig", () => {
  test("empty config is valid", () => {
    const c = parseScheduleConfig({});
    expect(c.jobs).toEqual([]);
    expect(c.allowUnattendedWrite).toBe(false);
    expect(typeof c.timezone).toBe("string");
  });
  test("rejects duplicate ids and bad timezones", () => {
    expect(() => parseScheduleConfig({ jobs: [base, base] })).toThrow();
    expect(() => parseScheduleConfig({ timezone: "Mars/Olympus" })).toThrow();
  });
});
