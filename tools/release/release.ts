// me release: the only way a change reaches the running me (DONE.md item 10).
// checks → CHANGELOG + tag + push → restart the local me in its Herdr pane → health check → refresh remote copies.
// Remote copies come from me.local.json: { "release": { "remotes": [{ "host": "rapi-agent", "dir": "~/me", "service": "me-ops-rapi" }] } }
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Remote = { host: string; dir: string; service: string; pluginId?: string };
export type ReleaseOptions = { root: string; bump: "minor" | "patch"; dryRun: boolean; skipE2e: boolean; log?: (line: string) => void };

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
  const run = (cmd: string[], opts: { cwd?: string; quiet?: boolean } = {}) => {
    const r = Bun.spawnSync(cmd, { cwd: opts.cwd ?? o.root, stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(r.stdout).trim();
    const err = new TextDecoder().decode(r.stderr).trim();
    if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode})\n${(err || out).slice(-2000)}`);
    return out;
  };
  const step = (name: string) => log(`▸ ${name}`);

  step("저장소 상태");
  if (run(["git", "rev-parse", "--show-toplevel"]) !== o.root) throw new Error(`release must run from the repository root, not a subdirectory`);
  if (run(["git", "branch", "--show-current"]) !== "main") throw new Error("release runs from main only");
  if (run(["git", "status", "--porcelain"])) throw new Error("working tree is not clean");
  run(["git", "fetch", "-q", "origin", "main"]);
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
  step(`버전 ${version} (이전 ${last ?? "없음"}, 커밋 ${subjects.length}개)`);
  if (o.dryRun) {
    log(subjects.map((s) => `  - ${s}`).join("\n"));
    log("dry run: 태그, 푸시, 재시작, 원격 갱신을 하지 않았어요.");
    return { version, dryRun: true };
  }

  const changelog = join(o.root, "CHANGELOG.md");
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(changelog, changelogEntry(existsSync(changelog) ? readFileSync(changelog, "utf8") : "", version, date, subjects));
  run(["git", "add", "CHANGELOG.md"]);
  run(["git", "commit", "-q", "-m", `release: ${version}`]);
  run(["git", "tag", "-a", version, "-m", `me ${version}`]);
  run(["git", "push", "-q", "origin", "main", version]);
  log(`  ${version} 태그를 푸시했어요.`);

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
