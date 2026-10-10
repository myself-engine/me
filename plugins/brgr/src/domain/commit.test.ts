import { describe, expect, test } from "bun:test";
import { CO_AUTHOR, commitMessage, touchedFiles, unquote } from "./commit.ts";

describe("commitMessage", () => {
  test("uses the first objective line, the task id, and the co-author trailer", () => {
    expect(commitMessage("Fix the login bug\n\nmore detail here", "abc-123")).toBe(
      "Fix the login bug\n\nApplied from brgr task abc-123 via me.\n\nCo-Authored-By: me <noreply@me.local>",
    );
  });

  test("caps the subject at 72 characters", () => {
    const subject = commitMessage("x".repeat(100), "t").split("\n")[0]!;
    expect(subject).toBe("x".repeat(72));
  });

  test("falls back to the task id when the objective has no first line", () => {
    expect(commitMessage("\n\nbody", "t9").split("\n")[0]).toBe("brgr task t9");
  });

  test("ends with the trailer as its own paragraph", () => {
    expect(commitMessage("a", "t").endsWith(`\n\n${CO_AUTHOR}`)).toBe(true);
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
