import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changelogEntry, createGithubRelease, draftReleaseNotes, fallbackReleaseNotes, findKernelPane,
  nextVersion, parseBump, release, releaseMaterial, releaseNotes, releaseNotesPrompt,
} from "./release.ts";

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir() { const dir = mkdtempSync(join(tmpdir(), "me-release-")); tempDirs.push(dir); return dir; }
const material = { commits: [{ subject: "feat: add status hints", body: "Show the next step." }, { subject: "fix: keep history", body: "" }], decisions: "새 항목 근거" };

describe("release", () => {
  test("parseBump defaults to patch", () => {
    expect(parseBump([])).toBe("patch");
    expect(parseBump(["--patch"])).toBe("patch");
    expect(parseBump(["--dry-run"])).toBe("patch");
    expect(parseBump(["--minor"])).toBe("minor");
    expect(parseBump(["--minor", "--dry-run"])).toBe("minor");
  });

  test("version bumps", () => {
    expect(nextVersion(null, "minor")).toBe("v0.1.0");
    expect(nextVersion("v0.3.2", "minor")).toBe("v0.4.0");
    expect(nextVersion("v0.3.2", "patch")).toBe("v0.3.3");
    expect(nextVersion("junk", "patch")).toBe("v0.1.0");
  });

  test("changelog prepends newest first and drops release commits", () => {
    const first = changelogEntry("", "v0.1.0", "2026-10-11", ["feat: a (abc)", "release: v0.0.9 (def)"]);
    expect(first).toBe("# CHANGELOG\n\n## v0.1.0 (2026-10-11)\n\n- feat: a (abc)\n");
    const second = changelogEntry(first, "v0.2.0", "2026-10-12", ["fix: b (123)"]);
    expect(second.indexOf("v0.2.0")).toBeLessThan(second.indexOf("v0.1.0"));
    expect(second.match(/# CHANGELOG/g)?.length).toBe(1);
  });

  test("finds the pane running this repository's kernel only", () => {
    const panes = [
      { paneId: "a", procs: [{ argv: ["bun", "bin/me.ts", "start", "me.config.json"], cwd: "/other/me", pid: 1 }] },
      { paneId: "b", procs: [{ argv: ["bun", "src/main.ts"], cwd: "/r/plugins/web", pid: 2 }, { argv: ["bun", "bin/me.ts", "start", "me.config.json"], cwd: "/r", pid: 3 }] },
    ];
    expect(findKernelPane(panes, "/r")).toEqual({ paneId: "b", pid: 3, argv: ["bun", "bin/me.ts", "start", "me.config.json"] });
    expect(findKernelPane(panes, "/none")).toBeNull();
  });

  test("release material requests subjects and bodies plus added decision lines for the exact range", () => {
    const calls: string[][] = [];
    const run = (cmd: string[]) => {
      calls.push(cmd);
      if (cmd.includes("log")) return "feat: one\u0000body one\u0000\u0001release: v0.1.1\u0000\u0000\u0001";
      return "@@ -2,0 +3 @@\n+새 결정\n-old line";
    };
    expect(releaseMaterial("/repo", "v0.1.0", "v0.2.0", run)).toEqual({ commits: [{ subject: "feat: one", body: "body one" }], decisions: "새 결정" });
    expect(calls[0]).toContain("v0.1.0..v0.2.0");
    expect(calls[1]).toContain("v0.1.0..v0.2.0");
  });

  test("fake head runner receives only supplied material with tools off, ephemeral and low thinking", async () => {
    const root = tempDir();
    writeFileSync(join(root, "me.config.json"), JSON.stringify({ pluginConfig: { "gjc-head": { harness: "omp", model: "primary", models: { omp: "selected" } } } }));
    const calls: any[] = [];
    const fake = async (input: any) => { calls.push(input); return { text: "# me v1.2.3\n\n이번 판은 이제 바뀐 화면을 설명해요.\n\n## 새로 생긴 것\n\n- 바뀌었어요.", sessionId: null, stopReason: null, violation: null }; };
    const plainPrompt = releaseNotesPrompt("v1.2.3", material, false);
    const jokePrompt = releaseNotesPrompt("v1.2.3", material, true);
    expect(jokePrompt.replace("첫 문장만 한국어로 가볍고 친근한 농담으로 시작하세요. 놀리거나 이모지를 쓰지 마세요. 그 다음 문장은 사실만 쓰세요.", "첫 문단은 한국어로 사실만 담아 1~3문장으로 씁니다.")).toBe(plainPrompt);
    const note = await draftReleaseNotes(root, "v1.2.3", material, false, { runHead: fake });
    expect(note).toContain("# me v1.2.3");
    expect(calls[0]).toMatchObject({ harness: "omp", model: "selected", allowTools: [], ephemeral: true, thinking: "low" });
    expect(calls[0].prompt).toContain("feat: add status hints");
    expect(calls[0].prompt).toContain("새 항목 근거");
    expect(calls[0].prompt).not.toContain("not supplied");
    expect(calls[0].prompt).toContain("첫 줄에 반드시 제목 '# me v1.2.3'을 쓰세요.");
  });

  test("accepts the live Korean draft, normalizes equivalent titles, and counts only sentence endings", async () => {
    const root = tempDir();
    writeFileSync(join(root, "me.config.json"), JSON.stringify({ pluginConfig: { "gjc-head": { harness: "gjc", model: "m" } } }));
    const draft = async (text: string, version = "v0.9.7") => draftReleaseNotes(root, version, material, false, { runHead: async () => ({ text, sessionId: null, stopReason: null, violation: null }) });
    const liveDraft = readFileSync(new URL("./fixtures/v0.9.7-live-draft.md", import.meta.url), "utf8");
    const acceptedLive = await draft(liveDraft);
    expect(acceptedLive).toStartWith("# me v0.9.7\n\nme v0.9.7에서는");
    expect(acceptedLive.match(/^# me v0\.9\.7$/gm)).toHaveLength(1);

    const titled = await draft("# me v0.9.7 릴리스 노트\n\n이번 변경은 README.md와 e.g. 예시를 함께 정리해요.\n\n## 고친 것\n\n- 반영했어요.");
    expect(titled).toStartWith("# me v0.9.7\n\n이번 변경");
    expect(titled.match(/^# me v0\.9\.7$/gm)).toHaveLength(1);

    const dottedVersion = await draft("v0.9.7에서는 README.md와 e.g. 표기를 함께 고쳤어요. 이제 잘 동작합니다.");
    expect(dottedVersion).toContain("README.md와 e.g. 표기를");
    expect(dottedVersion).not.toBe(fallbackReleaseNotes("v0.9.7", material));
  });

  test("rejects a draft with an unknown section heading", async () => {
    const root = tempDir();
    writeFileSync(join(root, "me.config.json"), JSON.stringify({ pluginConfig: { "gjc-head": { harness: "gjc", model: "m" } } }));
    const note = await draftReleaseNotes(root, "v1.2.3", material, false, { runHead: async () => ({
      text: "이번 변경을 담았어요.\n\n## 내부 구조\n\n- 바꿨어요.", sessionId: null, stopReason: null, violation: null,
    }) });
    expect(note).toBe(fallbackReleaseNotes("v1.2.3", material));
  });

  test("unusable or failed model output falls back to Korean headings and subjects", async () => {
    const root = tempDir();
    writeFileSync(join(root, "me.config.json"), JSON.stringify({ pluginConfig: { "gjc-head": { harness: "gjc", model: "m" } } }));
    const note = await draftReleaseNotes(root, "v2.0.0", material, false, { runHead: async () => { throw new Error("offline"); } });
    expect(note).toBe(fallbackReleaseNotes("v2.0.0", material));
    expect(note).toContain("## 새로 생긴 것");
    expect(note).toContain("## 고친 것");
    expect(note).toContain("feat: add status hints");
  });

  test("dry run prints the note and writes nothing", async () => {
    const root = tempDir();
    const calls: string[][] = [];
    const fakeCommand = (cmd: string[]) => {
      calls.push(cmd);
      if (cmd[1] === "rev-parse") return root;
      if (cmd[1] === "branch") return "main";
      if (cmd[1] === "rev-list") return "0";
      if (cmd[1] === "tag") return "v0.2.0";
      if (cmd[1] === "log" && cmd[2] === "--no-merges") return cmd[3]?.includes("%x00") ? "feat: x\u0000detail\u0000\u0001" : "feat: x (abc)";
      return "";
    };
    const lines: string[] = [];
    const written: string[] = [];
    const result = await release({ root, bump: "patch", dryRun: true, skipE2e: false, runCommand: fakeCommand, draft: async () => "# me v0.2.1\n\n이번 변경을 담았어요.", write: (path) => written.push(path), log: (line) => lines.push(line) });
    expect(result).toMatchObject({ version: "v0.2.1", dryRun: true });
    expect(lines.join("\n")).toContain("# me v0.2.1");
    expect(written).toEqual([]);
    expect(calls.some((cmd) => cmd.includes("fetch"))).toBe(false);
    expect(calls.some((cmd) => cmd[1] === "add" || cmd[1] === "commit" || cmd[1] === "push")).toBe(false);
    expect(() => readFileSync(join(root, "CHANGELOG.md"))).toThrow();
    expect(() => readFileSync(join(root, "docs/releases/v0.2.1.md"))).toThrow();

    calls.length = 0;
    const skipped = await release({ root, bump: "patch", dryRun: true, skipE2e: false, noNotes: true, runCommand: fakeCommand, draft: async () => { throw new Error("notes should be skipped"); }, log: () => {} });
    expect(skipped).toMatchObject({ notes: null });
    const noteMaterialCalls = calls.filter((cmd) => cmd[1] === "diff" || (cmd[1] === "log" && cmd[3]?.includes("%x00")));
    expect(noteMaterialCalls).toHaveLength(0);
  });

  test("GitHub release failures only emit a warning", () => {
    const lines: string[] = [];
    expect(() => createGithubRelease("v1.0.0", "/repo/docs/releases/v1.0.0.md", "/repo", () => { throw new Error("gh unavailable"); }, (line) => lines.push(line))).not.toThrow();
    expect(lines[0]).toContain("⚠");
    expect(lines[0]).toContain("gh unavailable");
  });

  test("notes range reads from and to refs and writes only the requested output", async () => {
    const calls: string[][] = [];
    const run = (cmd: string[]) => {
      calls.push(cmd);
      if (cmd[1] === "log") return "fix: ranged change\u0000body\u0000\u0001";
      if (cmd[1] === "diff") return "@@ -0,0 +1 @@\n+new decision";
      return "commit";
    };
    let outputPath = "";
    let content = "";
    const note = await releaseNotes({ root: "/repo", from: "v0.6.0", to: "v0.9.6", out: "catch-up.md" }, {
      run,
      draft: async (_root, version, got) => { expect(version).toBe("v0.9.6"); expect(got.commits[0]?.subject).toBe("fix: ranged change"); expect(got.decisions).toBe("new decision"); return "# note"; },
      write: (path, text) => { outputPath = path; content = text; },
    });
    expect(note).toBe("# note");
    expect(outputPath).toBe("/repo/catch-up.md");
    expect(content).toBe("# note");
    expect(calls.filter((cmd) => cmd[1] === "rev-parse").map((cmd) => cmd[3])).toEqual(["v0.6.0^{commit}", "v0.9.6^{commit}"]);
    expect(calls.some((cmd) => cmd[1] === "log" && cmd.includes("v0.6.0..v0.9.6"))).toBe(true);
    expect(calls.some((cmd) => ["commit", "tag", "push"].includes(cmd[1] ?? ""))).toBe(false);
  });
});
