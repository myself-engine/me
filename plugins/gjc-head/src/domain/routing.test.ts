import { describe, expect, test } from "bun:test";
import { FAST_PATH_MAX_CHARS, chooseHarness, decideRoute, fastPathJudgement, hasWorkSignal, isFastPath } from "./routing.ts";

describe("isFastPath", () => {
  test.each(["안녕", "ㅎㅇ", "오늘 뭐하지?", "고마워 잘했어", "  좋아요  ", "what's up"])("short chat %p is fast", (t) => {
    expect(isFastPath(t)).toBe(true);
  });

  test.each([
    "README 고쳐줘",
    "src/main.ts 봐줘",
    "main.ts 어때",
    "docs 정리한 거 .md로",
    "이 파일 뭐야",
    "코드 좀 봐",
    "버그 수정해",
    "기능 추가",
    "새 페이지 만들어줘",
    "리뷰 부탁",
    "커밋해",
    "배포 언제?",
    "테스트 돌려",
    "PR 올려줘",
    "repo 상태는?",
    "`ls` 해봐",
    "~/dev/me 열어",
  ])("work signal %p is not fast", (t) => {
    expect(isFastPath(t)).toBe(false);
  });

  test("length limit is on the trimmed text", () => {
    const at = "가".repeat(FAST_PATH_MAX_CHARS);
    expect(isFastPath(`  ${at}  `)).toBe(true);
    expect(isFastPath(at + "가")).toBe(false);
  });

  test("empty text is not fast", () => {
    expect(isFastPath("   ")).toBe(false);
  });

  test("plain words containing pr/repo letters are not signals", () => {
    expect(hasWorkSignal("price reporter")).toBe(false);
    expect(hasWorkSignal("PRs")).toBe(true);
  });

  test("fast-path judgement shows a full-simple badge", () => {
    expect(fastPathJudgement()).toMatchObject({ simpleProb: 1, source: "fast-path" });
  });
});

describe("decideRoute", () => {
  test("simple and no code change is direct", () => {
    expect(decideRoute({ needsCodeChange: false, simpleProb: 0.9, threshold: 0.8 })).toBe("direct");
    expect(decideRoute({ needsCodeChange: false, simpleProb: 0.8, threshold: 0.8 })).toBe("direct");
  });
  test("uncertain is delegated", () => {
    expect(decideRoute({ needsCodeChange: false, simpleProb: 0.79, threshold: 0.8 })).toBe("delegate");
  });
  test("code change is always delegated", () => {
    expect(decideRoute({ needsCodeChange: true, simpleProb: 1, threshold: 0.8 })).toBe("delegate");
  });
});

describe("chooseHarness", () => {
  const harnesses = ["local.claude-code", "local.codex", "local.gjc"];
  test("without amend keeps the suggestion", () => {
    expect(chooseHarness({ suggested: "local.codex", harnesses })).toEqual({ harness: "local.codex", amended: false });
    expect(chooseHarness({ suggested: "local.codex", harnesses, amend: {} })).toEqual({ harness: "local.codex", amended: false });
  });
  test("amend.harness overrides the suggestion", () => {
    expect(chooseHarness({ suggested: "local.codex", harnesses, amend: { harness: "local.claude-code" } })).toEqual({ harness: "local.claude-code", amended: true });
  });
  test("amend equal to the suggestion is not an override", () => {
    expect(chooseHarness({ suggested: "local.codex", harnesses, amend: { harness: "local.codex" } })).toEqual({ harness: "local.codex", amended: false });
  });
  test("unknown or malformed amend is ignored", () => {
    expect(chooseHarness({ suggested: "local.codex", harnesses, amend: { harness: "remote.evil" } }).harness).toBe("local.codex");
    expect(chooseHarness({ suggested: "local.codex", harnesses, amend: { harness: 3 } }).harness).toBe("local.codex");
  });
});
