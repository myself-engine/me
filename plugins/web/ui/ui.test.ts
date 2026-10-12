import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { diffTotals, parseDiffStat, splitDiff } from "./diff.ts";
import { fenceLanguage, highlight } from "./highlight.ts";
import { isDeep, parseRoute, settingsCloseHref, taskHref } from "./routes.ts";
import { GENERIC_HINT, checkHint, checkImpact, checkName } from "./ops.tsx";
import { Markdown, threadTime } from "./shared.tsx";
import { accessOf, activeAlerts, headChoice, initial, reducer, shortModel, taskTitle, threadApproval, threadPreview, threadTone, threadWait, toneOf, unlinkedApprovals, workItems, type State } from "./state.ts";
import type { Effort, HeadSettings } from "./api.ts";

const headDefaults = (): HeadSettings => ({ model: "openai-codex/gpt-5.6-luna", effort: "off" as Effort, favorites: [], efforts: [], workers: { models: {}, efforts: [] } });
describe("parseRoute", () => {
  test("defaults to chat", () => {
    expect(parseRoute("")).toEqual({ view: "chat", threadId: null });
    expect(parseRoute("#/nope")).toEqual({ view: "chat", threadId: null });
  });
  test("reads ids and redirects old routes", () => {
    expect(parseRoute("#/chat/t1")).toEqual({ view: "chat", threadId: "t1" });
    expect(parseRoute("#/task/a%2Fb")).toEqual({ view: "task", taskId: "a/b", threadId: null });
    expect(parseRoute(taskHref(null))).toEqual({ view: "chat", threadId: null });
    expect(parseRoute("#/settings")).toEqual({ view: "settings", section: null, fake: null });
    // Old routes redirect: tasks → chat / task panel, approvals → chat, ops/projects → settings.
    expect(parseRoute("#/tasks")).toEqual({ view: "chat", threadId: null });
    expect(parseRoute("#/tasks/a%2Fb")).toEqual({ view: "task", taskId: "a/b", threadId: null });
    expect(parseRoute("#/approvals")).toEqual({ view: "chat", threadId: null });
    expect(parseRoute("#/projects")).toEqual({ view: "settings", section: "projects", fake: null });
    expect(parseRoute("#/ops")).toEqual({ view: "settings", section: null, fake: null });
    expect(parseRoute("#/ops/harness")).toEqual({ view: "settings", section: "harness", fake: null });
    expect(parseRoute("#/ops/harness?fake=list")).toEqual({ view: "settings", section: "harness", fake: "list" });
  });
  test("detail screens are deep", () => {
    expect(isDeep(parseRoute("#/chat/t1"))).toBe(true);
    expect(isDeep(parseRoute("#/chat"))).toBe(false);
    expect(isDeep(parseRoute("#/task/abc"))).toBe(true);
    expect(isDeep(parseRoute("#/settings"))).toBe(false);
    expect(isDeep(parseRoute("#/settings/harness"))).toBe(true);
  });
});

describe("settingsCloseHref", () => {
  test("returns to the conversation or task panel settings opened from", () => {
    expect(settingsCloseHref("#/chat/t1")).toBe("#/chat/t1");
    expect(settingsCloseHref("#/chat")).toBe("#/chat");
    expect(settingsCloseHref("#/chat/new")).toBe("#/chat/new");
    expect(settingsCloseHref("#/task/a?thread=t1")).toBe("#/task/a?thread=t1");
  });
  test("a direct load of settings closes to plain chat", () => {
    expect(settingsCloseHref(null)).toBe("#/chat");
    expect(settingsCloseHref("")).toBe("#/chat");
    expect(settingsCloseHref("#")).toBe("#/chat");
    expect(settingsCloseHref("#/settings")).toBe("#/chat");
    expect(settingsCloseHref("#/settings/device")).toBe("#/chat");
  });
});

describe("device check plain reading", () => {
  const at = "2026-10-11T00:00:00.000Z";
  const base = { id: "nightly", kind: "command", ok: false, status: "down" as const, detail: "exit 1", latencyMs: 3, checkedAt: at, since: at };
  test("falls back to id, generic hint, and no chat impact", () => {
    expect(checkName(base)).toBe("nightly");
    expect(checkHint(base)).toBe(GENERIC_HINT);
    expect(checkHint(base)).toBe("설정한 명령을 터미널에서 직접 실행해 보세요");
    expect(checkImpact(base)).toBe("대화에는 영향 없어요.");
  });
  test("prefers the check's own name and hint", () => {
    expect(checkName({ ...base, name: "밤샘 작업" })).toBe("밤샘 작업");
    expect(checkHint({ ...base, hint: "작업 장치 전원을 확인하세요" })).toBe("작업 장치 전원을 확인하세요");
  });
  test("warns when the conversation path needs the check", () => {
    expect(checkImpact({ ...base, affectsChat: true })).toContain("대화");
    expect(checkImpact({ ...base, affectsChat: true })).not.toBe("대화에는 영향 없어요.");
    expect(checkImpact({ ...base, id: "gjc-model" })).not.toBe("대화에는 영향 없어요.");
  });
});

describe("diff helpers", () => {
  test("parses --stat output", () => {
    const s = parseDiffStat(" src/a.ts   | 12 +++++++---\n img.png    | Bin 0 -> 120 bytes\n 2 files changed, 9 insertions(+), 3 deletions(-)\n");
    expect(s.files).toEqual([
      { path: "src/a.ts", changes: 12, plus: 7, minus: 3 },
      { path: "img.png", changes: null, plus: 0, minus: 0 },
    ]);
    expect(s.summary).toBe("2 files changed, 9 insertions(+), 3 deletions(-)");
    expect(diffTotals(s)).toEqual({ files: 2, added: 9, removed: 3 });
    expect(diffTotals(parseDiffStat(" a.md | 1 +\n 1 file changed, 1 insertion(+)\n"))).toEqual({ files: 1, added: 1, removed: 0 });
  });
  test("splits a unified diff per file", () => {
    const d = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c\ndiff --git a/y.md b/y.md\n+++ b/y.md\n+z\n";
    const files = splitDiff(d);
    expect(files.map((f) => [f.path, f.added, f.removed])).toEqual([
      ["x.ts", 2, 1],
      ["y.md", 1, 0],
    ]);
    expect(splitDiff("")).toEqual([]);
  });
});

describe("status tones", () => {
  test("maps task states to buckets", () => {
    expect(["sealed", "awaiting-input", "apply-failed", "awaiting-approval"].map(toneOf)).toEqual(["needs", "needs", "needs", "needs"]);
    expect(toneOf("running")).toBe("running");
    expect(toneOf("applied")).toBe("done");
    expect(toneOf("reverted")).toBe("done");
    // Accepting starts the apply; only a landed commit counts as done.
    expect(toneOf("accepted")).toBe("running");
    expect(toneOf("failed")).toBe("failed");
    expect(toneOf("rejected")).toBe("muted");
  });

  const state = (): State => {
    const at = "2026-10-11T00:00:00.000Z";
    let s = reducer(initial, {
      type: "bootstrap",
      data: {
        token: "t",
        viewer: null,
        threads: [{ id: "th", title: "x", project: "/p", createdAt: at, updatedAt: at }],
        messages: [
          { id: "m1", threadId: "th", role: "assistant", text: "", ts: at, traceId: "tr1", status: "done", taskId: "k1" },
          { id: "m2", threadId: "th", role: "assistant", text: "", ts: at, traceId: "tr2", status: "pending" },
        ],
        tasks: [{ taskId: "k1", harness: "local.codex", objective: "o", project: "/p", state: "applied", outcome: null, resultText: null, error: null, createdAt: at, updatedAt: at }],
        plugins: [],
        ops: [],
        checks: [],
        approvals: [{ approvalId: "a1", requester: "gjc-head", summary: "s", risk: "low", payload: { messageId: "m2", harness: "local.gjc", brief: "b", project: "/p" } }],
        config: { projects: [], defaultProject: "", githubRepo: null },
      },
    });
    return s;
  };

  test("a pending delegation approval is a Needs You work item and wins the thread's status", () => {
    const s = state();
    const items = workItems(s);
    expect(items.map((w) => [w.id, w.state])).toContainEqual(["approval:a1", "awaiting-approval"]);
    expect(threadTone(s, "th")).toBe("needs");
  });

  test("a failed task shows on the thread, a rejected one stays quiet", () => {
    const base = state();
    const s: State = { ...base, approvals: {}, tasks: { k1: { ...base.tasks.k1!, state: "failed" } } };
    // The other turn is still pending, and running outranks a failure.
    expect(threadTone(s, "th")).toBe("running");
    const settled: State = { ...s, messages: { m1: s.messages.m1! } };
    expect(threadTone(settled, "th")).toBe("failed");
    expect(threadTone({ ...settled, tasks: { k1: { ...base.tasks.k1!, state: "rejected" } } }, "th")).toBe("none");
  });

  test("work titles use the user's own words, falling back to the brief", () => {
    const base = state();
    const user = { id: "u1", threadId: "th", role: "user" as const, text: "README에 설치 방법 섹션을 추가하고 커밋해 줘", ts: "2026-01-01T00:00:00.000Z", traceId: "tr1", status: "done" as const };
    const s: State = { ...base, messages: { ...base.messages, u1: user } };
    expect(taskTitle(s, { taskId: "k1", objective: "Add an install section" })).toBe("README에 설치 방법 섹션을 추가하고 커밋해 줘");
    expect(taskTitle(s, { taskId: "nope", objective: "Add an install section\nmore" })).toBe("Add an install section");
    expect(workItems(s).find((w) => w.id === "approval:a1")?.title).toBe("README에 설치 방법 섹션을 추가하고 커밋해 줘");
  });

  test("kernel.op entities land in state", () => {
    const s = reducer(state(), {
      type: "server",
      msg: { type: "entity", kind: "kernel.op", id: "o1", data: { opId: "o1", traceId: "tr2", callee: "gjc-head", state: "running", phaseLabel: "판정 중" } },
    });
    expect(s.ops.o1?.phaseLabel).toBe("판정 중");
  });

  test("blocking alerts land in state and only active ones count", () => {
    const alert = { id: "gjc-login", cause: "gjc-login", title: "GJC의 OpenAI 로그인이 만료됐어요", fix: "터미널에서 gjc 실행 후 /login", active: true, ts: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z" };
    let s = reducer(state(), { type: "server", msg: { type: "entity", kind: "gjc-head.alert", id: "gjc-login", data: alert } });
    expect(activeAlerts(s).map((a) => a.id)).toEqual(["gjc-login"]);
    s = reducer(s, { type: "server", msg: { type: "entity", kind: "gjc-head.alert", id: "gjc-login", data: { ...alert, active: false } } });
    expect(activeAlerts(s)).toEqual([]);
  });

  test("web.settings entities merge added projects without losing the config list", () => {
    let s = reducer(initial, {
      type: "bootstrap",
      data: { token: "t", viewer: null, threads: [], messages: [], tasks: [], plugins: [], ops: [], checks: [], approvals: [], alerts: [], config: { projects: ["/base"], addedProjects: [], defaultProject: "", githubRepo: null } },
    });
    s = reducer(s, { type: "server", msg: { type: "entity", kind: "web.settings", id: "default", data: { id: "default", projects: ["/added"] } } });
    expect(s.config.projects).toEqual(["/base", "/added"]);
    expect(s.config.addedProjects).toEqual(["/added"]);
    s = reducer(s, { type: "server", msg: { type: "entity", kind: "web.settings", id: "default", data: { id: "default", projects: [] } } });
    expect(s.config.projects).toEqual(["/base"]);
  });

  test("sidebar waiting words: approval beats review beats answering beats failure", () => {
    const s = state();
    // a1 waits on m2 → 승인.
    expect(threadWait(s, "th")).toBe("승인");
    const noApproval: State = { ...s, approvals: {} };
    // m2 streams with no task → 답변.
    expect(threadWait(noApproval, "th")).toBe("답변");
    const sealed: State = { ...noApproval, tasks: { k1: { ...noApproval.tasks.k1!, state: "sealed" } } };
    expect(threadWait(sealed, "th")).toBe("검토");
    const failed: State = { ...noApproval, tasks: { k1: { ...noApproval.tasks.k1!, state: "failed" } }, messages: { m1: noApproval.messages.m1! } };
    expect(threadWait(failed, "th")).toBe("실패");
    expect(threadWait(failed, "missing")).toBeNull();
  });

  test("unlinked approvals exclude delegations; threadApproval finds the thread's pending ask", () => {
    const s = state();
    expect(unlinkedApprovals(s)).toEqual([]);
    const withOps: State = {
      ...s,
      approvals: { ...s.approvals, ops1: { approvalId: "ops1", requester: "harness-config", summary: "적용", risk: "medium", payload: {} } },
    };
    expect(unlinkedApprovals(withOps).map((a) => a.approvalId)).toEqual(["ops1"]);
    expect(threadApproval(withOps, "th")?.approvalId).toBe("a1");
    expect(threadApproval(withOps, null)).toBeUndefined();
    expect(threadApproval(withOps, "missing")).toBeUndefined();
  });

  test("access mode falls back to project-write until the backend stores it", () => {
    expect(accessOf(null, null)).toBe("project");
    expect(accessOf(null, { ...headDefaults(), access: "read" })).toBe("read");
    expect(accessOf({ access: "full" }, { ...headDefaults(), access: "read" })).toBe("full");
  });
});

describe("highlight", () => {
  test("reads the fence language from the class", () => {
    expect(fenceLanguage("language-ts")).toBe("ts");
    expect(fenceLanguage("foo language-Diff")).toBe("diff");
    expect(fenceLanguage(undefined)).toBeNull();
    expect(fenceLanguage("hljs")).toBeNull();
  });
  test("highlights registered languages and their aliases", () => {
    for (const lang of ["ts", "typescript", "js", "json", "bash", "sh", "diff", "python", "py", "go", "rust", "css", "html", "xml", "md", "yaml", "yml", "sql"])
      expect(highlight("x", lang), lang).not.toBeNull();
    expect(highlight("+hello\n-bye", "diff")).toContain('class="hljs-addition"');
  });
  test("returns null for unknown or missing languages instead of throwing", () => {
    expect(highlight("x", "cobol")).toBeNull();
    expect(highlight("x", null)).toBeNull();
  });
  test("escapes the source", () => {
    expect(highlight("<img src=x onerror=alert(1)>", "html")).not.toContain("<img");
  });
});

describe("head choice", () => {
  const d = { model: "openai-codex/gpt-5.6-luna", effort: "off" as const, favorites: [], efforts: [], workers: { models: {}, efforts: [] } };
  test("follows the defaults until a thread has its own choice", () => {
    expect(headChoice({}, d)).toEqual({ model: d.model, effort: "off", isDefault: true });
    expect(headChoice({ model: null, effort: "high" }, d)).toEqual({ model: d.model, effort: "high", isDefault: false });
    expect(headChoice({}, null)).toBeNull();
  });
  test("settings entities land in state and chips drop the provider", () => {
    const s = reducer(initial, { type: "server", msg: { type: "entity", kind: "gjc-head.settings", id: "default", data: d } });
    expect(s.headSettings?.model).toBe(d.model);
    expect(shortModel("openai-codex/gpt-6.1-sol")).toBe("gpt-6.1-sol");
    expect(shortModel("bare")).toBe("bare");
  });
});

describe("app.css", () => {
  test("braces balance, so no rule swallows the rest of the file", async () => {
    const css = (await Bun.file(new URL("./app.css", import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    let depth = 0;
    for (const ch of css) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
describe("markdown bold", () => {
  const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));
  test("renders bold when closing ** is directly followed by Hangul", () => {
    const out = html("**미( me )**입니다");
    expect(out).toContain("<strong>미( me )</strong>입니다");
    expect(out).not.toContain("**");
  });
  test("leaves normal emphasis, code spans and lone runs alone", () => {
    expect(html("a **bold** c")).toContain("<strong>bold</strong>");
    expect(html("**굵게** 다음")).toContain("<strong>굵게</strong>");
    expect(html("어제 **작업**과 **오늘**일정")).toContain("<strong>오늘</strong>일정");
    expect(html("2 ** 3은 거듭제곱")).toContain("**");
    expect(html("`**코드**`입니다")).not.toContain("<strong>");
  });
});

describe("sidebar rows", () => {
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).toISOString();
  test("threadTime shows clock times inside the week", () => {
    // Wednesday noon.
    const now = new Date(2026, 9, 14, 12, 0).getTime();
    expect(threadTime(at(2026, 9, 14, 11, 50), now)).toBe("10분 전");
    expect(threadTime(at(2026, 9, 13, 14, 2), now)).toBe("어제 14:02");
    // Three days back is Sunday.
    expect(threadTime(at(2026, 9, 11, 9, 10), now)).toBe("일 09:10");
    expect(threadTime(at(2026, 9, 1, 9, 10), now)).toBe("13일 전");
  });
  const previewState = (): State => {
    const day = "2026-10-14T12:00:00.000Z";
    return reducer(initial, {
      type: "bootstrap",
      data: {
        token: "t",
        viewer: null,
        threads: [{ id: "th", title: "같은 제목", project: "/p", createdAt: day, updatedAt: day }],
        messages: [
          { id: "m1", threadId: "th", role: "assistant", text: "# 제목\n**첫 답변**입니다", ts: day, traceId: "tr1", status: "done" },
          { id: "m2", threadId: "th", role: "assistant", text: "", ts: day, traceId: "tr2", status: "error", error: "gjc error: Your authentication token has expired." },
        ],
        tasks: [],
        plugins: [],
        ops: [],
        checks: [],
        approvals: [],
        config: { projects: [], defaultProject: "", githubRepo: null },
      },
    });
  };
  test("threadPreview shows the latest reply text, never the raw error", () => {
    const s = previewState();
    expect(threadPreview(s, "th")).toBe("첫 답변입니다");
    expect(threadPreview(s, "missing")).toBeNull();
  });
});
