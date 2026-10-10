// me doctor: read-only health checks (DECISIONS §16 점검 항목).
//   1. external tool versions, snapshotted to $ME_HOME/doctor/versions.json and diffed against the last run
//   2. symlinks: broken, or pointing outside the root they must stay in
//   3. plugin conformance (spec/conformance), skipping plugins whose methods would call paid models
// Never modifies anything except its own version snapshot.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadManifest } from "../../kernel/src/manifest.ts";
import { runConformance } from "../../spec/conformance/run.ts";

// ---------- versions ----------

export interface ToolVersion {
  name: string;
  /** Resolved path (`which`), or null when the tool is not on PATH. */
  path: string | null;
  /** First line the version command printed; null when missing or when every version command failed. */
  version: string | null;
  /** Why the version could not be read, when the tool exists. */
  error?: string;
}

export interface VersionSnapshot {
  at: string;
  tools: ToolVersion[];
}

export interface VersionChange {
  name: string;
  /** null = missing in that snapshot. */
  from: string | null;
  to: string | null;
}

/** Each tool with the argument lists to try in order (the first that exits 0 wins). */
export const TOOLS: { name: string; args: string[][] }[] = [
  { name: "bun", args: [["--version"]] },
  { name: "gjc", args: [["--version"], ["version"]] },
  { name: "brgr", args: [["--version"], ["version"]] },
  { name: "herdr", args: [["--version"], ["version"]] },
  { name: "claude", args: [["--version"]] },
  { name: "codex", args: [["--version"]] },
  { name: "gh", args: [["--version"]] },
  { name: "git", args: [["--version"]] },
  { name: "tailscale", args: [["version"], ["--version"]] },
  { name: "python3", args: [["--version"]] },
];

async function runFor(cmd: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code: proc.signalCode ? null : code, out: `${out}\n${err}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeTool(
  name: string,
  argLists: string[][],
  opts: { PATH?: string; timeoutMs?: number } = {},
): Promise<ToolVersion> {
  const path = Bun.which(name, opts.PATH ? { PATH: opts.PATH } : undefined);
  if (!path) return { name, path: null, version: null };
  let last = "";
  for (const args of argLists) {
    try {
      const r = await runFor([path, ...args], opts.timeoutMs ?? 10_000);
      const line = r.out.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      if (r.code === 0 && line) return { name, path, version: line };
      last = r.code === null ? `${args.join(" ")}: timed out` : `${args.join(" ")}: exit ${r.code}${line ? ` (${line.slice(0, 80)})` : ""}`;
    } catch (err) {
      last = `${args.join(" ")}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { name, path, version: null, error: last };
}

export function probeVersions(tools = TOOLS, opts: { PATH?: string; timeoutMs?: number } = {}): Promise<ToolVersion[]> {
  return Promise.all(tools.map((t) => probeTool(t.name, t.args, opts)));
}

/** Tools whose version changed, appeared or disappeared since `prev`. No previous snapshot ⇒ no changes. */
export function diffVersions(prev: ToolVersion[] | null | undefined, next: ToolVersion[]): VersionChange[] {
  if (!prev) return [];
  const before = new Map(prev.map((t) => [t.name, t.version]));
  const after = new Map(next.map((t) => [t.name, t.version]));
  const changes: VersionChange[] = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(name) ?? null;
    const to = after.get(name) ?? null;
    if (from !== to) changes.push({ name, from, to });
  }
  return changes;
}

// ---------- symlinks ----------

export type SymlinkStatus = "ok" | "broken" | "outside";

export interface SymlinkFinding {
  path: string;
  /** Raw link text (readlink). */
  target: string;
  /** Fully resolved target; absent when broken. */
  resolved?: string;
  status: SymlinkStatus;
  detail?: string;
}

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Classify one symlink. With `expectedRoot`, a target outside it (after resolving both sides) is "outside". */
export function classifySymlink(linkPath: string, expectedRoot?: string): SymlinkFinding {
  const target = readlinkSync(linkPath);
  let resolved: string;
  try {
    resolved = realpathSync(linkPath);
  } catch (err: any) {
    return { path: linkPath, target, status: "broken", detail: err?.code ?? String(err) };
  }
  if (expectedRoot) {
    let root: string;
    try {
      root = realpathSync(expectedRoot);
    } catch {
      root = resolve(expectedRoot);
    }
    if (!inside(root, resolved)) return { path: linkPath, target, resolved, status: "outside", detail: `not under ${root}` };
  }
  return { path: linkPath, target, resolved, status: "ok" };
}

export interface SymlinkScan {
  dir: string;
  /** Root every link must resolve inside; absent = only broken links are problems. */
  expectedRoot?: string;
  exists: boolean;
  /** Whether a missing `dir` counts as a failure. */
  required: boolean;
  links: SymlinkFinding[];
}

/** Classify the symlinks directly inside `dir` (one level, like node_modules/@me/* or skills/*). */
export function scanSymlinks(dir: string, expectedRoot?: string, required = false): SymlinkScan {
  if (!existsSync(dir)) return { dir, expectedRoot, exists: false, required, links: [] };
  const links: SymlinkFinding[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (lstatSync(p).isSymbolicLink()) links.push(classifySymlink(p, expectedRoot));
  }
  return { dir, expectedRoot, exists: true, required, links };
}

export const scanOk = (s: SymlinkScan) => (s.exists || !s.required) && s.links.every((l) => l.status === "ok");

// ---------- config ----------

export type SymlinkRootEntry = string | { path: string; root?: string };

export interface DoctorConfig {
  /** Directories whose symlinks are checked. A `{ path, root }` entry also requires links to resolve inside `root`. */
  symlinkRoots: SymlinkRootEntry[];
  /** Plugin ids never run through conformance because their methods call paid models. */
  skipConformance: string[];
}

export const DEFAULT_DOCTOR: DoctorConfig = {
  symlinkRoots: ["~/.claude/skills", "~/.agents/skills"],
  skipConformance: ["summarize", "jev", "gjc-head"],
};

export interface LoadedConfig {
  base: string;
  dataDir: string;
  /** Plugin directories, absolute. */
  plugins: string[];
  pluginConfig: Record<string, Record<string, unknown>>;
  doctor: DoctorConfig;
}

export const expandHome = (p: string, base: string) =>
  p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(base, p);

/** Same merge rules as kernel/src/main.ts, plus a `doctor` section (local keys override). */
export async function loadConfig(configPath: string, env: Record<string, string | undefined> = process.env): Promise<LoadedConfig> {
  const base = dirname(resolve(configPath));
  const config: any = await Bun.file(configPath).json();
  const localFile = Bun.file(join(base, "me.local.json"));
  const local: any = (await localFile.exists()) ? await localFile.json() : {};
  let plugins: string[] = local.plugins ?? config.plugins ?? [];
  plugins = [...new Set([...plugins, ...(local.extraPlugins ?? [])])];
  const pluginConfig: Record<string, Record<string, unknown>> = { ...(config.pluginConfig ?? {}) };
  for (const [id, cfg] of Object.entries<Record<string, unknown>>(local.pluginConfig ?? {})) pluginConfig[id] = { ...pluginConfig[id], ...cfg };
  return {
    base,
    dataDir: expandHome(env.ME_HOME ?? local.dataDir ?? config.dataDir ?? "~/.me", base),
    plugins: plugins.map((p) => expandHome(p, base)),
    pluginConfig,
    doctor: { ...DEFAULT_DOCTOR, ...(config.doctor ?? {}), ...(local.doctor ?? {}) },
  };
}

// ---------- conformance ----------

export interface ConformanceRow {
  pluginId: string;
  dir: string;
  status: "PASS" | "FAIL" | "SKIP";
  /** Failed check names with details, or why it was skipped. */
  detail: string[];
}

/**
 * Config for a conformance run. A numeric `port` becomes 0 (any free port) so the run
 * never collides with a kernel that is already serving on the configured port.
 */
export function conformanceConfig(cfg: Record<string, unknown> | undefined): Record<string, unknown> {
  const c = { ...(cfg ?? {}) };
  if (typeof c.port === "number") c.port = 0;
  return c;
}

export async function checkConformance(cfg: LoadedConfig, log: (s: string) => void = () => {}): Promise<ConformanceRow[]> {
  const rows: ConformanceRow[] = [];
  const skip = new Set(cfg.doctor.skipConformance);
  for (const dir of cfg.plugins) {
    let id: string;
    try {
      id = (await loadManifest(join(dir, "plugin.json"))).id;
    } catch (err) {
      rows.push({ pluginId: "?", dir, status: "FAIL", detail: [`manifest: ${err instanceof Error ? err.message : String(err)}`] });
      continue;
    }
    if (skip.has(id)) {
      rows.push({ pluginId: id, dir, status: "SKIP", detail: ["유료 모델 호출 (doctor.skipConformance)"] });
      continue;
    }
    log(`적합성 검사: ${id}`);
    const r = await runConformance(dir, { config: conformanceConfig(cfg.pluginConfig[id]) });
    rows.push({
      pluginId: id,
      dir,
      status: r.ok ? "PASS" : "FAIL",
      detail: r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
    });
  }
  return rows;
}

// ---------- report ----------

export interface DoctorReport {
  ok: boolean;
  versions: {
    snapshotPath: string;
    previousAt: string | null;
    tools: ToolVersion[];
    changes: VersionChange[];
  };
  symlinks: SymlinkScan[];
  conformance: ConformanceRow[];
}

export async function runDoctor(
  root: string,
  opts: { configPath?: string; log?: (s: string) => void; env?: Record<string, string | undefined> } = {},
): Promise<DoctorReport> {
  const cfg = await loadConfig(opts.configPath ?? join(root, "me.config.json"), opts.env);

  const tools = await probeVersions();
  const snapshotPath = join(cfg.dataDir, "doctor", "versions.json");
  const prevFile = Bun.file(snapshotPath);
  let prev: VersionSnapshot | null = null;
  try {
    if (await prevFile.exists()) prev = await prevFile.json();
  } catch {
    prev = null; // unreadable snapshot: treat as first run
  }
  const changes = diffVersions(prev?.tools, tools);
  mkdirSync(dirname(snapshotPath), { recursive: true });
  await Bun.write(snapshotPath, JSON.stringify({ at: new Date().toISOString(), tools } satisfies VersionSnapshot, null, 2) + "\n");

  const symlinks = [
    scanSymlinks(join(root, "node_modules", "@me"), root, true),
    ...cfg.doctor.symlinkRoots.map((e) =>
      typeof e === "string" ? scanSymlinks(expandHome(e, cfg.base)) : scanSymlinks(expandHome(e.path, cfg.base), e.root ? expandHome(e.root, cfg.base) : undefined),
    ),
  ];

  const conformance = await checkConformance(cfg, opts.log);

  const ok = tools.every((t) => t.version !== null) && symlinks.every(scanOk) && conformance.every((r) => r.status !== "FAIL");
  return { ok, versions: { snapshotPath, previousAt: prev?.at ?? null, tools, changes }, symlinks, conformance };
}

/** Terminal width of a string: Hangul and other wide characters take two columns. */
function width(s: string) {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
}
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - width(s)));

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ""))));
  const line = (r: string[]) => "  " + r.map((c, i) => (i === r.length - 1 ? c : pad(c, widths[i]!))).join("  ");
  return [line(header), ...rows.map(line)];
}

const tilde = (p: string) => (p.startsWith(homedir() + "/") ? "~" + p.slice(homedir().length) : p);

export function formatReport(r: DoctorReport, root: string): string {
  const out: string[] = ["me doctor", ""];

  out.push("[외부 도구 버전]");
  out.push(
    ...table(
      ["도구", "상태", "버전", "경로"],
      r.versions.tools.map((t) => [
        t.name,
        t.path === null ? "없음" : t.version === null ? "실패" : "정상",
        t.version ?? t.error ?? "-",
        t.path ? tilde(t.path) : "-",
      ]),
    ),
  );
  if (r.versions.previousAt === null) out.push("  버전 변화: 첫 기록");
  else if (r.versions.changes.length === 0) out.push(`  버전 변화: 없음 (지난 기록 ${r.versions.previousAt})`);
  else {
    out.push(`  버전 변화 (지난 기록 ${r.versions.previousAt}):`);
    for (const c of r.versions.changes) out.push(`    ${c.name}: ${c.from ?? "없음"} → ${c.to ?? "없음"}`);
  }
  out.push(`  기록: ${tilde(r.versions.snapshotPath)}`, "");

  out.push("[심링크]");
  out.push(
    ...table(
      ["위치", "결과", "링크", "문제"],
      r.symlinks.map((s) => {
        const bad = s.links.filter((l) => l.status !== "ok");
        const where = s.dir.startsWith(root + "/") ? relative(root, s.dir) : tilde(s.dir);
        if (!s.exists) return [where, s.required ? "FAIL" : "-", "0", "디렉터리 없음"];
        return [where, bad.length ? "FAIL" : "PASS", String(s.links.length), bad.length ? `${bad.length}개` : "-"];
      }),
    ),
  );
  for (const s of r.symlinks)
    for (const l of s.links.filter((l) => l.status !== "ok"))
      out.push(`    ${l.status === "broken" ? "깨짐" : "범위 밖"}  ${tilde(l.path)} → ${l.target}${l.status === "outside" ? ` (${l.detail})` : ""}`);
  out.push("");

  out.push("[플러그인 적합성]");
  out.push(
    ...table(
      ["플러그인", "결과", "비고"],
      r.conformance.map((c) => [c.pluginId, c.status, c.status === "PASS" ? relative(root, c.dir) || c.dir : (c.detail[0] ?? "")]),
    ),
  );
  for (const c of r.conformance.filter((c) => c.status === "FAIL")) for (const d of c.detail.slice(1, 4)) out.push(`    ${c.pluginId}: ${d}`);
  out.push("");

  const fails = [
    ...r.versions.tools.filter((t) => t.version === null).map((t) => `도구 ${t.name}`),
    ...r.symlinks.filter((s) => !scanOk(s)).map((s) => `심링크 ${tilde(s.dir)}`),
    ...r.conformance.filter((c) => c.status === "FAIL").map((c) => `적합성 ${c.pluginId}`),
  ];
  out.push(fails.length ? `결과: 실패 ${fails.length}건 — ${fails.join(", ")}` : "결과: 모두 정상");
  return out.join("\n");
}
