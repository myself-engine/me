// me up: `me` with no arguments. Bring the kernel up, print the URLs, open the browser.
//
// First run does two one-time chores (each prints at most one Korean line, only on
// change): install the login agent (tools/autostart) and link ~/.local/bin/me so the
// next run can be a bare `me`. The kernel itself always starts in a Herdr pane through
// the existing autostart run logic, never inside the calling pane.
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { install as installAutostart, plistPath, run as runAutostart } from "../autostart/autostart.ts";
import { proxyTarget, serveStatus } from "../tailscale/serve.ts";

export const DEFAULT_WEB_PORT = 7420;

/** Port from parsed configs: me.local.json wins, then me.config.json, then 7420. */
export function resolveWebPort(localCfg: unknown, baseCfg: unknown): number {
  const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535 ? v : undefined);
  const at = (c: unknown) => num((c as any)?.pluginConfig?.web?.port);
  return at(localCfg) ?? at(baseCfg) ?? DEFAULT_WEB_PORT;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Web port for this checkout (reads me.local.json plus the named base config). */
export function readWebPort(root: string, config: string): number {
  return resolveWebPort(readJson(join(root, "me.local.json")), readJson(join(root, config)));
}

export const localUrl = (port: number) => `http://127.0.0.1:${port}`;

export interface WebHandler {
  hostPort: string;
  path: string;
  proxy: string | null;
}

/** Phone URL when `tailscale serve` proxies this kernel, else null. */
export function phoneUrlFor(handlers: WebHandler[], port: number): string | null {
  const ours = (h: WebHandler) => h.path === "/" && (h.proxy === proxyTarget(port) || h.proxy === `127.0.0.1:${port}`);
  const hit = handlers.find(ours);
  return hit ? `https://${hit.hostPort}/` : null;
}

export function helpText(): string {
  return [
    "me — 그냥 me만 치면 켜고 브라우저를 연다",
    "",
    "사용: me [명령] [옵션]   (명령 없이 me만 치면 켜기 + 브라우저 열기, --no-open으로 생략)",
    "",
    "켜기",
    "  me (up)                       켜고 브라우저 열기",
    "  start [설정]                  커널 실행",
    "  autostart install             로그인할 때 자동으로 켜기",
    "  autostart uninstall           로그인 자동 시작 끄기",
    "  autostart run                 Herdr pane에서 커널 시작 (이미 돌면 가만히 둠)",
    "  install                       me를 PATH에 연결 (~/.local/bin/me)",
    "",
    "붙이기",
    "  adapt mcp <이름> -- <명령>    MCP 서버 붙이기",
    "  adapt cli <이름> <파일>       명령줄 도구 붙이기",
    "  adapt market                  레시피 목록 보기",
    "  adapt <레시피>                레시피로 설치하기",
    "  adapt agent <이름> -- <내용>  어댑터 작성을 워커에게 맡기기",
    "  adapt export <플러그인> -- <설명>  만든 어댑터를 레시피로 내보내기",
    "  connect <플러그인> --host <IP>  다른 머신의 플러그인을 이 커널에 붙이기",
    "",
    "설정·폰·점검",
    "  config plan|import|apply      하네스 설정을 한 곳에서 관리",
    "  tailscale status|on|off       폰에서 쓰기 (테일넷만, 공개 아님)",
    "  doctor [--json]               외부 도구·심링크·플러그인 점검",
    "  release [--minor]             검사·태그·재시작까지 한 번에 반영",
    "",
    "도움",
    "  help (-h, --help)             이 도움말 보기",
  ].join("\n");
}

export const binDir = (home: string) => join(home, ".local", "bin");
export const binPath = (home: string) => join(binDir(home), "me");

/** Whether ~/.local/bin is on PATH (so a bare `me` resolves). Pure. */
export function binOnPath(pathEnv: string | undefined, home: string): boolean {
  return (pathEnv ?? "").split(":").includes(binDir(home));
}

export type BinDecision = "ok" | "create" | "replace" | "keep-foreign";

/**
 * What ensureBinLink should do given the current link target (null = missing, "" = a plain file). Pure.
 * Only a link to another me checkout is replaced; someone else's `me` is never touched.
 */
export function decideBinLink(existing: string | null, want: string): BinDecision {
  if (existing === want) return "ok";
  if (existing === null) return "create";
  return existing.endsWith("/bin/me.ts") ? "replace" : "keep-foreign";
}

const tilde = (p: string, home: string) => (p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);

export function ensureBinLink(root: string, home: string = homedir()): { path: string; display: string; changed: boolean; onPath: boolean; foreign: boolean } {
  const path = binPath(home);
  const want = join(root, "bin", "me.ts");
  mkdirSync(binDir(home), { recursive: true });
  let existing: string | null = null;
  try {
    existing = readlinkSync(path);
  } catch (err: any) {
    if (err?.code !== "ENOENT" && err?.code !== "EINVAL") throw err;
    // ENOENT: missing. EINVAL: a plain file, not a link → replace it.
    existing = err?.code === "EINVAL" ? "" : null;
  }
  const decision = decideBinLink(existing, want);
  if (decision === "create" || decision === "replace") {
    rmSync(path, { force: true });
    symlinkSync(want, path);
  }
  const changed = decision === "create" || decision === "replace";
  return { path, display: tilde(path, home), changed, onPath: binOnPath(process.env.PATH, home), foreign: decision === "keep-foreign" };
}

async function checkHealthy(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/api/bootstrap`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
}

function openBrowser(url: string): void {
  if (process.platform !== "darwin") return;
  Bun.spawn(["open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

export interface UpOptions {
  root: string;
  config?: string;
  noOpen?: boolean;
  home?: string;
  tty?: boolean;
  log?: (line: string) => void;
  open?: (url: string) => void;
}

/** `me` with no arguments: first-run chores, start via Herdr when down, print URLs, open. */
export async function up(o: UpOptions): Promise<void> {
  const log = o.log ?? console.log;
  const home = o.home ?? homedir();
  const config = o.config ?? "me.config.json";
  const port = readWebPort(o.root, config);

  // First run: login agent (undo: me autostart uninstall) and a PATH link. Both no-op later.
  if (!existsSync(plistPath(home))) {
    installAutostart({ root: o.root, config, home, log: () => {} });
    log("로그인 에이전트를 설치했어요. 되돌리려면: me autostart uninstall");
  }
  const bin = ensureBinLink(o.root, home);
  if (bin.foreign) log(`${bin.display}에 다른 프로그램이 있어서 연결하지 않았어요. 이 저장소에서 bun bin/me.ts로 실행하세요.`);
  else if (bin.changed) {
    log(
      bin.onPath
        ? `me를 PATH에 연결했어요 (${bin.display})`
        : `${bin.display}를 만들었는데 ~/.local/bin이 PATH에 없어요. 셸 설정에 export PATH="$HOME/.local/bin:$PATH"를 추가하세요.`,
    );
  }

  if (!(await checkHealthy(port))) {
    log("me를 시작하는 중이에요 (Herdr pane)…");
    try {
      await runAutostart({ root: o.root, config, port, log: () => {} });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (/timed out waiting for the Herdr server/.test(msg)) log("Herdr 서버가 실행 중이 아니에요. Herdr를 먼저 실행한 뒤 다시 me를 실행하세요.");
      else if (/ENOENT|herdr: command not found|spawn herdr/i.test(msg)) log("Herdr가 설치돼 있지 않아요. Herdr를 설치한 뒤 다시 me를 실행하세요.");
      else if (/timed out waiting for me/.test(msg)) log(`me가 Herdr의 "me kernel" 창에서 시작했지만 ${port}에서 응답하지 않아요. 그 창의 오류를 확인하세요.`);
      else log(`me를 시작하지 못했어요: ${msg}`);
      process.exit(1);
    }
  }

  const url = localUrl(port);
  log(url);
  try {
    const phone = phoneUrlFor((await serveStatus()).handlers, port);
    if (phone) log(`폰: ${phone}`);
  } catch {
    // Tailscale off or missing: the local URL is enough.
  }
  if (!o.noOpen && (o.tty ?? process.stdout.isTTY === true)) (o.open ?? openBrowser)(url);
}
