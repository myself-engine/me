// me release: the only way a change reaches the running me (DONE.md item 10).
// checks → CHANGELOG + tag + push → restart the local me in its Herdr pane → health check → refresh remote copies.
// Remote copies come from me.local.json: { "release": { "remotes": [{ "host": "rapi-agent", "dir": "~/me", "service": "me-ops-rapi" }] } }
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runHead, type HeadHarness, type RunnerResult } from "../../lib/runner/index.ts";

export type Remote = { host: string; dir: string; service: string; pluginId?: string };
export type ReleaseOptions = {
  root: string; bump: "minor" | "patch"; dryRun: boolean; skipE2e: boolean;
  joke?: boolean; noNotes?: boolean; log?: (line: string) => void;
  runCommand?: (cmd: string[], cwd: string) => string;
  draft?: (root: string, version: string, material: ReleaseMaterial, joke: boolean) => Promise<string>;
  write?: (path: string, content: string) => void;
};

export type ReleaseMaterial = { commits: { subject: string; body: string }[]; decisions: string };
type CommandRunner = (cmd: string[], cwd: string) => string;

const DEFAULT_TIMEOUT_MS = 45_000;

function command(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(r.stdout).trim();
  const err = new TextDecoder().decode(r.stderr).trim();
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode})\n${(err || out).slice(-2000)}`);
  return out;
}

/** Read only the commit subjects/bodies and newly added decision lines in a range. */
export function releaseMaterial(root: string, from: string | null, to = "HEAD", run: CommandRunner = command): ReleaseMaterial {
  const range = from ? `${from}..${to}` : to;
  const commits = run(["git", "log", "--no-merges", "--format=%s%x00%b%x00%x01", range], root)
    .split("\u0001").map((entry) => entry.replace(/\u0000+$/, "").trim()).filter(Boolean).map((entry) => {
      const [subject = "", ...body] = entry.split("\u0000");
      return { subject: subject.trim(), body: body.join("\u0000").trim() };
    }).filter(({ subject }) => subject && !/^release: v/.test(subject));
  const diff = from ? run(["git", "diff", "--unified=0", `${from}..${to}`, "--", "docs/DECISIONS.md"], root) : "";
  const decisions = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++" )).map((line) => line.slice(1)).join("\n").trim();
  return { commits, decisions };
}

export function releaseNotesPrompt(version: string, material: ReleaseMaterial, joke = false, title = version): string {
  const opening = joke
    ? [
      "첫 문장은 자료에서 가장 큰 변경과 연결된 실제 농담이어야 합니다. me나 me를 쓰는 사람을 한국어 해요체로 가볍게 놀리는 짧은 한 줄로 쓰세요. 외모나 지능을 심하게 놀리지 말고, 욕설과 이모지는 쓰지 말며, 40자 안팎을 넘기지 마세요. 따뜻한 요약으로 시작하지 마세요.",
      "말투 참고 예시(그대로 복사하지 마세요): 이제 기억력이 당신보다 똑똑할 수도 있어요 / 이제 me가 당신보다 먼저 일어나요 / 되돌리기가 생겨서 실수해도 아무도 몰라요.",
      "첫 문장 뒤의 내용은 사실만 쓰세요.",
    ].join("\n")
    : "첫 문단은 한국어로 사실만 담아 1~3문장으로 씁니다.";
  return [
    `# me ${title}`,
    "이 자료만 사용해 me를 쓰는 사람을 위한 한국어 릴리스 노트를 작성하세요. 개발자용 설명이나 추측을 덧붙이지 마세요.",
    `첫 줄에 반드시 제목 '# me ${title}'을 쓰세요.`,
    opening,
    "자료가 설명하는 범위를 정확히 유지하세요. 예를 들어 대화별 설정을 기본 설정처럼 넓혀 쓰지 마세요. 범위가 모호하면 세부 내용을 추측하지 말고 생략하세요. 필요한 경우에만 다음 제목을 사용하세요: ## 새로 생긴 것, ## 고친 것, ## 알아둘 것. 각 항목은 빠진 점이나 문제와 이제 달라진 점을 1~2문장으로 씁니다. 해시와 파일 경로는 사용자가 직접 해야 할 때만 씁니다. 확인되지 않은 실제 동작은 알아둘 것에 적습니다. 마크다운 노트만 출력하세요.",
    "제공된 커밋 제목·본문:",
    JSON.stringify(material.commits),
    "이전 릴리스 이후 추가된 docs/DECISIONS.md 내용:",
    material.decisions || "(없음)",
  ].join("\n\n");
}

export function fallbackReleaseNotes(version: string, material: ReleaseMaterial, title = version): string {
  const groups: Record<string, string[]> = { "새로 생긴 것": [], "고친 것": [], "알아둘 것": [] };
  for (const { subject } of material.commits) {
    const kind = /^(feat|add|new)(\(|:)/i.test(subject) ? "새로 생긴 것" : /^(fix|bug)(\(|:)/i.test(subject) ? "고친 것" : "알아둘 것";
    groups[kind]!.push(`- ${subject} 항목을 반영했어요.`);
  }
  const sections = Object.entries(groups).filter(([, items]) => items.length).map(([title, items]) => `## ${title}\n\n${items.join("\n")}`);
  return [`# me ${title}`, "이번 버전에는 다음 변경을 담았어요.", ...sections].join("\n\n") + "\n";
}

function usableNote(text: string, version: string, title = version): string | null {
  let note = text.trim().replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```$/, "").trim();
  const lines = note.split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versionTitle = new RegExp(`^#?\\s*me\\s+${escapedVersion}(?:\\s+.+)?$`, "i");
  const expectedTitle = new RegExp(`^#?\\s*me\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  if (firstLine.startsWith("#")) {
    if (!versionTitle.test(firstLine) && !expectedTitle.test(firstLine)) return null;
    note = lines.slice(1).join("\n").trim();
  } else if (versionTitle.test(firstLine) || expectedTitle.test(firstLine)) {
    note = lines.slice(1).join("\n").trim();
  }
  const allowed = new Set(["새로 생긴 것", "고친 것", "알아둘 것"]);
  for (const heading of note.matchAll(/^## (.+)$/gm)) if (!allowed.has(heading[1]!)) return null;
  const firstSection = note.search(/^## /m);
  const opening = note.slice(0, firstSection < 0 ? undefined : firstSection).trim();
  const sentenceText = opening.replace(/\b(?:e\.g|i\.e|etc|vs|dr|mr|ms|prof)\./gi, (abbreviation) => abbreviation.replace(/\./g, ""));
  const sentenceEnds = [...sentenceText.matchAll(/[!?。]+|\.(?=\s|$)/g)];
  const tail = sentenceEnds.at(-1);
  const sentenceCount = sentenceEnds.length + (tail ? sentenceText.slice(tail.index! + tail[0].length).trim() ? 1 : 0 : 1);
  return opening && sentenceCount <= 3 ? `# me ${title}\n\n${note}\n` : null;
}

/** Model notes are best effort: abort after a short bound and always return a local fallback. */
export async function draftReleaseNotes(root: string, version: string, material: ReleaseMaterial, joke = false, opts: {
  runHead?: (input: Parameters<typeof runHead>[0]) => Promise<RunnerResult>; timeoutMs?: number;
  title?: string;
} = {}): Promise<string> {
  const title = opts.title ?? version;
  const fallback = fallbackReleaseNotes(version, material, title);
  const config = readJson(join(root, "me.config.json"));
  const head = config?.pluginConfig?.["gjc-head"] ?? {};
  const harness = head.harness as HeadHarness;
  const model = head.models?.[harness] ?? head.model;
  if (!(["gjc", "omp"] as string[]).includes(harness) || typeof model !== "string" || !model) return fallback;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = opts.runHead ?? runHead;
  try {
    const result = await Promise.race([
      run({ harness, model, cwd: root, prompt: releaseNotesPrompt(version, material, joke, title), allowTools: [], ephemeral: true, thinking: "low", signal: controller.signal }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("release note draft timed out")); }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS); }),
    ]);
    return usableNote(result.text, version, title) ?? fallback;
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createGithubRelease(version: string, notePath: string, root: string, run: CommandRunner = command, log: (line: string) => void = console.log): void {
  try {
    run(["gh", "release", "create", version, "--title", `me ${version}`, "--notes-file", notePath], root);
  } catch (error) {
    log(`  ⚠ GitHub 릴리스 생성에 실패했어요: ${String(error).split("\n")[0]}`);
  }
}

export type NotesRangeOptions = { root: string; from: string; to?: string; joke?: boolean; out?: string; log?: (line: string) => void };

/** Return the first version tag on the first-parent path after `from`, falling back to `to`. */
export function firstReleaseAfter(from: string, to: string, run: CommandRunner = command, root = process.cwd()): string {
  const history = run(["git", "log", "--first-parent", "--reverse", "--decorate=short", "--format=%H%x00%D", `${from}..${to}`], root);
  for (const line of history.split("\n")) {
    const decorations = line.split("\u0000")[1] ?? "";
    const tag = decorations.match(/(?:^|, )tag: (v\d+\.\d+\.\d+)(?:,|$)/)?.[1];
    if (tag) return tag;
  }
  return to;
}

export async function releaseNotes(o: NotesRangeOptions, deps: { run?: CommandRunner; draft?: typeof draftReleaseNotes; write?: (path: string, text: string) => void } = {}) {
  const run = deps.run ?? command;
  const to = o.to ?? "HEAD";
  run(["git", "rev-parse", "--verify", `${o.from}^{commit}`], o.root);
  run(["git", "rev-parse", "--verify", `${to}^{commit}`], o.root);
  const material = releaseMaterial(o.root, o.from, to, run);
  const version = to === "HEAD"
    ? nextVersion(run(["git", "tag", "--list", "v*", "--sort=-v:refname"], o.root).split("\n").filter(Boolean)[0] ?? null, "patch")
    : to;
  const title = to === "HEAD" ? version : `${firstReleaseAfter(o.from, to, run, o.root)} ~ ${to}`;
  const note = await (deps.draft ?? draftReleaseNotes)(o.root, version, material, o.joke ?? false, { title });
  if (o.out) (deps.write ?? writeFileSync)(resolve(o.root, o.out), note);
  else (o.log ?? console.log)(note.trimEnd());
  return note;
}

/** No flag means patch; --minor opts into minor; --patch is accepted and changes nothing. */
export function parseBump(args: string[]): "minor" | "patch" {
  return args.includes("--minor") ? "minor" : "patch";
}

/** vX.Y.Z → next version. No tag yet → v0.1.0. */
export function nextVersion(last: string | null, bump: "minor" | "patch"): string {
  const m = last?.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return "v0.1.0";
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return bump === "patch" ? `v${maj}.${min}.${pat + 1}` : `v${maj}.${min + 1}.0`;
}

/** Prepends one release section to the changelog text. Release commits themselves are left out. */
export function changelogEntry(existing: string, version: string, date: string, subjects: string[]): string {
  const lines = subjects.filter((s) => !/^release: v/.test(s)).map((s) => `- ${s}`);
  const section = `## ${version} (${date})\n\n${lines.length ? lines.join("\n") : "- 변경 없음"}\n`;
  const head = "# CHANGELOG\n";
  const body = existing.startsWith(head) ? existing.slice(head.length).replace(/^\n+/, "") : existing;
  return `${head}\n${section}${body ? `\n${body}` : ""}`;
}

/** Picks the pane whose foreground runs `bin/me.ts start` from this repository. */
export function findKernelPane(panes: { paneId: string; procs: { argv: string[]; cwd: string; pid: number }[] }[], root: string) {
  for (const p of panes)
    for (const proc of p.procs)
      if (proc.cwd === root && proc.argv.includes("bin/me.ts") && proc.argv.includes("start")) return { paneId: p.paneId, pid: proc.pid, argv: proc.argv };
  return null;
}

export async function release(o: ReleaseOptions) {
  const log = o.log ?? ((l: string) => console.log(l));
  const run = (cmd: string[], opts: { cwd?: string; quiet?: boolean } = {}) => (o.runCommand ?? command)(cmd, opts.cwd ?? o.root);
  const step = (name: string) => log(`▸ ${name}`);

  step("저장소 상태");
  if (run(["git", "rev-parse", "--show-toplevel"]) !== o.root) throw new Error(`release must run from the repository root, not a subdirectory`);
  if (run(["git", "branch", "--show-current"]) !== "main") throw new Error("release runs from main only");
  if (run(["git", "status", "--porcelain"])) throw new Error("working tree is not clean");
  if (!o.dryRun) run(["git", "fetch", "-q", "origin", "main"]);
  if (run(["git", "rev-list", "--count", "HEAD..origin/main"]) !== "0") throw new Error("origin/main has commits that are not here; pull first");

  step("검사: tsc");
  run(["bunx", "tsc", "--noEmit", "-p", "."]);
  step("검사: bun test");
  run(["bun", "test"]);
  if (o.skipE2e) log("  (E2E 건너뜀: --skip-e2e)");
  else {
    step("검사: E2E");
    log(run(["bun", "scripts/e2e.ts"]).split("\n").map((l) => `  ${l}`).join("\n"));
  }

  const tags = run(["git", "tag", "--list", "v*", "--sort=-v:refname"]).split("\n").filter(Boolean);
  const last = tags[0] ?? null;
  const version = nextVersion(last, o.bump);
  const subjects = run(["git", "log", "--no-merges", "--format=%s (%h)", ...(last ? [`${last}..HEAD`] : [])]).split("\n").filter(Boolean);
  const material = o.noNotes ? null : releaseMaterial(o.root, last, "HEAD", (cmd, cwd) => run(cmd, { cwd }));
  const notePath = join(o.root, "docs", "releases", `${version}.md`);
  const note = material ? await (o.draft ?? draftReleaseNotes)(o.root, version, material, o.joke ?? false) : "";
  step(`버전 ${version} (이전 ${last ?? "없음"}, 커밋 ${subjects.length}개)`);
  if (o.dryRun) {
    log(subjects.map((s) => `  - ${s}`).join("\n"));
    if (note) log(note.trimEnd());
    log("dry run: 태그, 푸시, 재시작, 원격 갱신을 하지 않았어요.");
    return { version, dryRun: true, notes: note || null };
  }

  const changelog = join(o.root, "CHANGELOG.md");
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(changelog, changelogEntry(existsSync(changelog) ? readFileSync(changelog, "utf8") : "", version, date, subjects));
  if (note) {
    mkdirSync(dirname(notePath), { recursive: true });
    (o.write ?? writeFileSync)(notePath, note);
  }
  run(["git", "add", "CHANGELOG.md", ...(note ? [join("docs", "releases", `${version}.md`)] : [])]);
  run(["git", "commit", "-q", "-m", `release: ${version}`]);
  run(["git", "tag", "-a", version, "-m", `me ${version}`]);
  run(["git", "push", "-q", "origin", "main", version]);
  log(`  ${version} 태그를 푸시했어요.`);
  if (note) createGithubRelease(version, notePath, o.root, (cmd, cwd) => run(cmd, { cwd }), log);

  const local = readJson(join(o.root, "me.local.json"));
  const shared = readJson(join(o.root, "me.config.json"));
  const webPort = Number(local?.pluginConfig?.web?.port ?? shared?.pluginConfig?.web?.port ?? 7420);

  step("실행 중인 me 재시작");
  const pane = await kernelPane(o.root);
  if (!pane) log("  ⚠ 실행 중인 me를 찾지 못했어요. 직접 시작하세요: bun bin/me.ts start me.config.json");
  else {
    process.kill(pane.pid, "SIGTERM");
    if (!(await waitGone(pane.pid, 20_000))) throw new Error(`me (pid ${pane.pid}) did not stop within 20s`);
    run(["herdr", "pane", "run", pane.paneId, pane.argv.join(" ")]);
    log(`  ${pane.paneId}에서 다시 시작했어요 (이전 pid ${pane.pid}).`);
  }

  step("상태 확인");
  const remotes: Remote[] = local?.release?.remotes ?? [];
  const health = await waitHealthy(webPort, [], 60_000);
  log(health.ok ? `  플러그인 ${health.running.length}개 실행 중` : `  ⚠ 실행 중이 아닌 플러그인: ${health.down.join(", ")}`);

  for (const r of remotes) {
    step(`원격 사본 갱신: ${r.host}:${r.dir} (${r.service})`);
    run(["rsync", "-az", "--delete", "--exclude", "node_modules", "--exclude", ".git", "--exclude", ".me", "--exclude", ".shots", "--exclude", "me.local.json", "--exclude", "*.sqlite*", `${o.root}/`, `${r.host}:${r.dir}/`]);
    const state = run(["ssh", r.host, `bash -lc 'cd ${r.dir} && bun install --frozen-lockfile >/dev/null 2>&1; systemctl --user restart ${r.service} && sleep 2 && systemctl --user is-active ${r.service}'`]);
    log(`  ${r.service}: ${state}`);
  }
  if (remotes.some((r) => r.pluginId)) {
    const back = await waitHealthy(webPort, remotes.flatMap((r) => (r.pluginId ? [r.pluginId] : [])), 60_000);
    log(back.ok ? "  원격 플러그인이 다시 접속했어요." : `  ⚠ 다시 접속하지 않은 원격 플러그인: ${back.down.join(", ")}`);
  }
  log(`✓ ${version} 릴리스 완료`);
  return { version, dryRun: false };
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function kernelPane(root: string) {
  const herdr = (args: string[]) => {
    const r = Bun.spawnSync(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0 ? JSON.parse(new TextDecoder().decode(r.stdout)) : null;
  };
  const list = herdr(["pane", "list"]);
  const ids: string[] = (list?.result?.panes ?? []).map((p: any) => p.pane_id ?? p.id).filter(Boolean);
  const panes = ids.map((paneId) => ({ paneId, procs: herdr(["pane", "process-info", "--pane", paneId])?.result?.process_info?.foreground_processes ?? [] }));
  return findKernelPane(panes, root);
}

async function waitGone(pid: number, ms: number) {
  for (let t = 0; t < ms; t += 200) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(200);
  }
  return false;
}

/** Polls the web bootstrap until every plugin runs and the required ids are present. */
async function waitHealthy(port: number, required: string[], ms: number) {
  let running: string[] = [];
  let down: string[] = ["web"];
  for (let t = 0; t < ms; t += 1000) {
    const boot: any = await fetch(`http://127.0.0.1:${port}/api/bootstrap`).then((r) => r.json()).catch(() => null);
    if (boot) {
      const plugins: any[] = boot.plugins ?? [];
      running = plugins.filter((p) => p.state === "running").map((p) => p.pluginId ?? p.id);
      down = [...plugins.filter((p) => p.state !== "running").map((p) => `${p.pluginId ?? p.id}(${p.state})`), ...required.filter((id) => !running.includes(id))];
      if (!down.length) return { ok: true, running, down };
    }
    await Bun.sleep(1000);
  }
  return { ok: false, running, down };
}
