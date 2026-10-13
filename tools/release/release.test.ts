import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changelogEntry, createGithubRelease, draftReleaseNotes, fallbackReleaseNotes, findKernelPane,
  firstReleaseAfter, nextVersion, parseBump, release, releaseMaterial, releaseNotes, releaseNotesPrompt,
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

  test("release prompt asks for bilingual notes, localized jokes, and the configured maintainer", async () => {
    const root = tempDir();
    writeFileSync(join(root, "me.config.json"), JSON.stringify({ maintainer: "Mina", pluginConfig: { "gjc-head": { harness: "omp", model: "primary", models: { omp: "selected" } } } }));
    const calls: any[] = [];
    const fake = async (input: any) => { calls.push(input); return { text: "# me v1.2.3\n\n이번 판은 이제 바뀐 화면을 설명해요.\n\n## 새로 생긴 것\n\n- 바뀌었어요.", sessionId: null, stopReason: null, violation: null }; };
    const plainPrompt = releaseNotesPrompt("v1.2.3", material, false);
    const jokePrompt = releaseNotesPrompt("v1.2.3", material, true, "v1.2.3", "Mina");
    expect(plainPrompt).toContain("## New");
    expect(plainPrompt).toContain("## 새로 생긴 것");
    expect(plainPrompt).toContain("---");
    expect(jokePrompt).toContain("이제 기억력이 당신보다 똑똑할 수도 있어요");
    expect(jokePrompt).toContain("Mina가 좀 더 나은 기능을 생각했어요");
    expect(jokePrompt).toContain("shit");
    expect(jokePrompt).toContain("damn");
    expect(jokePrompt).toContain("가장 큰 변경과 연결된 짧은 실제 농담");
    expect(jokePrompt).toContain("자료가 설명하는 범위를 정확히 유지하세요");
    const note = await draftReleaseNotes(root, "v1.2.3", material, true, { runHead: fake });
    expect(note).toContain("# me v1.2.3");
    expect(calls[0]).toMatchObject({ harness: "omp", model: "selected", allowTools: [], ephemeral: true, thinking: "low" });
    expect(calls[0].prompt).toContain("feat: add status hints");
    expect(calls[0].prompt).toContain("새 항목 근거");
    expect(calls[0].prompt).not.toContain("not supplied");
    expect(calls[0].prompt).toContain("첫 줄에 반드시 제목 '# me v1.2.3'을 쓰세요.");
    expect(calls[0].prompt).toContain("Mina를 3인칭으로");
  });

  test("accepts bilingual drafts, normalizes titles, and counts sentences in each opening", async () => {
    const root = tempDir();
    writeFileSync(join(root, "me.config.json"), JSON.stringify({ pluginConfig: { "gjc-head": { harness: "gjc", model: "m" } } }));
    const draft = async (text: string, version = "v0.9.7", title = version) => draftReleaseNotes(root, version, material, false, { title, runHead: async () => ({ text, sessionId: null, stopReason: null, violation: null }) });
    const liveDraft = readFileSync(new URL("./fixtures/v0.9.7-live-draft.md", import.meta.url), "utf8");
    const acceptedLive = await draft(liveDraft);
    expect(acceptedLive).toStartWith("# me v0.9.7\n\nIn me v0.9.7");
    expect(acceptedLive.match(/^# me v0\.9\.7$/gm)).toHaveLength(1);

    const titled = await draft("# me v0.9.7 릴리스 노트\n\nThis update covers README.md and e.g. examples.\n\n## Fixed\n\n- The change is included.\n\n---\n\n이번 변경은 README.md와 e.g. 예시를 함께 정리해요.\n\n## 고친 것\n\n- 반영했어요.");
    expect(titled).toStartWith("# me v0.9.7\n\nThis update");
    expect(titled.match(/^# me v0\.9\.7$/gm)).toHaveLength(1);

    const ranged = await draft("# me v0.6.0 ~ v0.9.7\n\nThis range supports release notes.\n\n---\n\n이 범위의 릴리스 노트를 지원해요.", "v0.9.7", "v0.6.0 ~ v0.9.7");
    expect(ranged).toStartWith("# me v0.6.0 ~ v0.9.7\n\nThis range");

    const dottedVersion = await draft("v0.9.7 includes README.md and e.g. formatting. It works now.\n\n---\n\nv0.9.7은 README.md와 e.g. 표기를 함께 고쳤어요. 이제 잘 동작합니다.");
    expect(dottedVersion).toContain("README.md and e.g. formatting");
    expect(dottedVersion).not.toBe(fallbackReleaseNotes("v0.9.7", material));
  });

  test("rejects a missing separator, wrong-language or unordered heading, empty section, or excessive opening sentences", async () => {
    const root = tempDir();
    writeFileSync(join(root, "me.config.json"), JSON.stringify({ pluginConfig: { "gjc-head": { harness: "gjc", model: "m" } } }));
    const invalidDrafts = [
      "This release has changes.\n\n이번 변경을 담았어요.",
      "This release has changes.\n\n## 고친 것\n\n- changed\n\n---\n\n이번 변경을 담았어요.",
      "This release has changes.\n\n## Fixed\n\n- changed\n\n## New\n\n- added\n\n---\n\n이번 변경을 담았어요.",
      "This release has changes.\n\n## New\n\n---\n\n이번 변경을 담았어요.",
      "One. Two. Three. Four.\n\n---\n\n이번 변경을 담았어요.",
    ];
    for (const text of invalidDrafts) {
      const note = await draftReleaseNotes(root, "v1.2.3", material, false, { runHead: async () => ({ text, sessionId: null, stopReason: null, violation: null }) });
      expect(note).toBe(fallbackReleaseNotes("v1.2.3", material));
    }
  });

  test("fallback keeps commit subjects in English and points Korean readers to that list", async () => {
    const root = tempDir();
    writeFileSync(join(root, "me.config.json"), JSON.stringify({ pluginConfig: { "gjc-head": { harness: "gjc", model: "m" } } }));
    const note = await draftReleaseNotes(root, "v2.0.0", material, false, { runHead: async () => { throw new Error("offline"); } });
    expect(note).toBe(fallbackReleaseNotes("v2.0.0", material));
    expect(note).toContain("## Worth knowing");
    expect(note).toContain("---");
    expect(note).toContain("## 알아둘 것\n\n위 영어 목록과 같은 변경이에요");
    expect(note).toContain("feat: add status hints");
    expect(note).not.toContain("feat: add status hints 항목");
    const ranged = await draftReleaseNotes(root, "v0.9.7", material, false, {
      title: "v0.6.0 ~ v0.9.7",
      runHead: async () => { throw new Error("offline"); },
    });
    expect(ranged).toStartWith("# me v0.6.0 ~ v0.9.7\n");
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
      if (cmd[1] === "log" && cmd.includes("--first-parent")) return "a1\u0000tag: v0.6.0\na2\u0000tag: v0.8.0";
      if (cmd[1] === "log") return "fix: ranged change\u0000body\u0000\u0001";
      if (cmd[1] === "diff") return "@@ -0,0 +1 @@\n+new decision";
      return "commit";
    };
    let outputPath = "";
    let content = "";
    const note = await releaseNotes({ root: "/repo", from: "v0.6.0", to: "v0.9.6", out: "catch-up.md" }, {
      run,
      draft: async (_root, version, got, _joke, options) => { expect(version).toBe("v0.9.6"); expect(options?.title).toBe("v0.6.0 ~ v0.9.6"); expect(got.commits[0]?.subject).toBe("fix: ranged change"); expect(got.decisions).toBe("new decision"); return "# note"; },
      write: (path, text) => { outputPath = path; content = text; },
    });
    expect(note).toBe("# note");
    expect(outputPath).toBe("/repo/catch-up.md");
    expect(content).toBe("# note");
    expect(calls.filter((cmd) => cmd[1] === "rev-parse").map((cmd) => cmd[3])).toEqual(["v0.6.0^{commit}", "v0.9.6^{commit}"]);
    expect(calls.some((cmd) => cmd[1] === "log" && cmd.includes("v0.6.0..v0.9.6"))).toBe(true);
    expect(calls.some((cmd) => ["commit", "tag", "push"].includes(cmd[1] ?? ""))).toBe(false);
    expect(firstReleaseAfter("v0.5.0", "v0.9.6", (cmd) => cmd.includes("--first-parent") ? "a1\u0000tag: v0.6.0\na2\u0000tag: v0.8.0" : "", "/repo")).toBe("v0.6.0");
    expect(firstReleaseAfter("v0.9.0", "v0.9.6", () => "", "/repo")).toBe("v0.9.6");
  });
});
