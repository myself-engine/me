import { describe, expect, test } from "bun:test";
import { CO_AUTHOR, commitMessage, normalizeCommitSubject, touchedFiles, truncateSubject, unquote } from "./commit.ts";

describe("normalizeCommitSubject", () => {
  test("collapses whitespace, strips quotes and the trailing period", () => {
    expect(normalizeCommitSubject('  "Add  multiply\nfunction."  ')).toBe("Add multiply function");
  });

  test("caps at a word boundary without adding anything", () => {
    const s = normalizeCommitSubject(`${"word ".repeat(30)}tail`);
    expect(s.length).toBeLessThanOrEqual(72);
    expect(s.endsWith("tail")).toBe(false);
    expect(/\s$/.test(s)).toBe(false);
  });

  test("spaceless text cuts hard at 60", () => {
    expect(normalizeCommitSubject("x".repeat(100))).toBe("x".repeat(60));
  });

  test("non-strings and empty input give empty string", () => {
    expect(normalizeCommitSubject(undefined)).toBe("");
    expect(normalizeCommitSubject('"."')).toBe("");
  });
});

describe("truncateSubject", () => {
  test("short text passes through trimmed", () => {
    expect(truncateSubject("  hi  ")).toBe("hi");
  });

  test("long text never cuts mid-word and stays within max", () => {
    const s = truncateSubject("Add a very long feature name that goes on and on and on past the limit", 40);
    expect(s.length).toBeLessThanOrEqual(40);
    expect("Add a very long feature name that goes on and on and on past the limit".startsWith(`${s} `)).toBe(true);
  });
});

describe("commitMessage", () => {
  test("subject present: used as-is, request appears in the body", () => {
    expect(
      commitMessage({ taskId: "abc-123", objective: "long brief here", commitSubject: "Add multiply function", request: "곱하기 함수 추가해줘" }),
    ).toBe(
      `Add multiply function\n\nRequested: 곱하기 함수 추가해줘\n\nApplied from brgr task abc-123 via me.\n\n${CO_AUTHOR}`,
    );
  });

  test("missing subject: falls back to the request first line", () => {
    const m = commitMessage({ taskId: "t", objective: "In the project, inspect the existing math module and test conventions, then add.", request: "README 오타 고쳐줘\n자세히" });
    expect(m.split("\n")[0]).toBe("README 오타 고쳐줘");
    expect(m).toContain("Requested: README 오타 고쳐줘 자세히");
  });

  test("missing subject and request: falls back to the brief's first sentence", () => {
    const m = commitMessage({ taskId: "t", objective: "In the project, inspect the existing math module. Then add a test." });
    expect(m.split("\n")[0]).toBe("In the project, inspect the existing math module");
  });

  test("Korean request without spaces cuts at 60 chars, never mid-word", () => {
    const req = "가".repeat(100);
    const m = commitMessage({ taskId: "t", objective: "brief", request: req });
    expect(m.split("\n")[0]).toBe("가".repeat(60));
  });

  test("very long text: word boundary, no trailing additions", () => {
    const objective = `${"word ".repeat(40)}tail`;
    const subject = commitMessage({ taskId: "t", objective }).split("\n")[0]!;
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(objective.startsWith(`${subject} `)).toBe(true);
  });

  test("no request: body is just the applied line", () => {
    expect(commitMessage({ taskId: "t9", objective: "" })).toBe(
      `brgr task t9\n\nApplied from brgr task t9 via me.\n\n${CO_AUTHOR}`,
    );
  });

  test("request is trimmed to 300 chars in the body", () => {
    const m = commitMessage({ taskId: "t", objective: "b", request: `x\ny${"z".repeat(500)}` });
    expect(m).toContain(`Requested: ${`x y${"z".repeat(297)}`.slice(0, 300)}`);
  });

  test("legacy string form keeps the old three-paragraph shape", () => {
    expect(commitMessage("Fix the login bug\n\nmore detail here", "abc-123")).toBe(
      `Fix the login bug\n\nApplied from brgr task abc-123 via me.\n\n${CO_AUTHOR}`,
    );
  });

  test("ends with the trailer as its own paragraph", () => {
    expect(commitMessage({ taskId: "t", objective: "a" }).endsWith(`\n\n${CO_AUTHOR}`)).toBe(true);
  });
});

describe("touchedFiles", () => {
  test("modify, add, delete", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "--- a/not-a-header.ts",
      "+x",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+hi",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
    ].join("\n");
    expect(touchedFiles(diff)).toEqual(["src/a.ts", "new.txt", "old.txt"]);
  });

  test("renames stage both sides", () => {
    const diff = ["diff --git a/from.ts b/to.ts", "similarity index 100%", "rename from from.ts", "rename to to.ts"].join("\n");
    expect(touchedFiles(diff)).toEqual(["from.ts", "to.ts"]);
  });

  test("paths with spaces and quoted non-ASCII paths", () => {
    const diff = [
      "diff --git a/my file.txt b/my file.txt",
      "--- a/my file.txt\t",
      "+++ b/my file.txt\t",
      "@@ -1 +1 @@",
      'diff --git "a/\\352\\260\\200.txt" "b/\\352\\260\\200.txt"',
      "--- \"a/\\352\\260\\200.txt\"",
      "+++ \"b/\\352\\260\\200.txt\"",
      "@@ -1 +1 @@",
    ].join("\n");
    expect(touchedFiles(diff)).toEqual(["my file.txt", "가.txt"]);
  });

  test("binary and mode-only changes have no ---/+++ lines", () => {
    expect(touchedFiles("diff --git a/img.png b/img.png\nindex 1..2\nBinary files a/img.png and b/img.png differ\n")).toEqual(["img.png"]);
  });

  test("empty diff touches nothing", () => {
    expect(touchedFiles("")).toEqual([]);
  });

  test("unquote decodes escapes", () => {
    expect(unquote('"a\\tb\\"c"')).toBe('a\tb"c');
    expect(unquote("plain")).toBe("plain");
  });
});
