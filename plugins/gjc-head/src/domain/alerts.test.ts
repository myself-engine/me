import { describe, expect, test } from "bun:test";
import { describeFailure, friendlyError } from "./alerts.ts";

describe("describeFailure", () => {
  test("GJC provider login expiry maps to the /login fix", () => {
    const a = describeFailure(new Error("gjc error: provider login expired (openai)"));
    expect(a).toMatchObject({ cause: "gjc-login", title: "GJC의 OpenAI 로그인이 만료됐어요" });
    expect(a!.fix).toContain("터미널에서 gjc 실행 후 /login");
    expect(friendlyError(new Error("gjc error: provider login expired"))).toContain("GJC의 OpenAI 로그인이 만료됐어요 · 터미널에서 gjc 실행 후 /login");
  });
  test("Korean login-expiry text maps too", () => {
    expect(describeFailure("GJC의 OpenAI 로그인이 만료됐어요")?.cause).toBe("gjc-login");
  });
  test("Herdr pane refusal maps to restarting with me", () => {
    const a = describeFailure(new Error("커널이 에이전트 없는 Herdr pane에서 실행돼야 brgr로 위임할 수 있어요"));
    expect(a?.cause).toBe("herdr-pane");
    expect(a!.fix).toContain("me");
    expect(describeFailure(new Error("brgr needs the exact Herdr source pane"))?.cause).toBe("herdr-pane");
  });
  test("uncommitted changes map to commit-or-stash", () => {
    const a = describeFailure(new Error("대상 저장소에 커밋되지 않은 변경이 있어 위임할 수 없어요: /repo"));
    expect(a).toMatchObject({ cause: "dirty-repo" });
    expect(describeFailure(new Error("workspace has uncommitted changes"))?.cause).toBe("dirty-repo");
  });
  test("refused models map to picking another model", () => {
    expect(describeFailure(new Error("gpt-x은 Claude Code에서만 쓸 수 있어요"))?.cause).toBe("model-refused");
    expect(describeFailure(new Error("model foo is not allowed inside GJC (Claude runs only in Claude Code)"))?.cause).toBe("model-refused");
    expect(describeFailure(new Error("effort는 off, low 중 하나예요"))?.cause).toBe("model-refused");
  });
  test("unknown errors stay raw", () => {
    expect(describeFailure(new Error("something completely new"))).toBeNull();
    expect(friendlyError(new Error("something completely new"))).toBe("something completely new");
  });
});
