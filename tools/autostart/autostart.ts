// me autostart: bring the kernel up after login, inside an agent-free Herdr pane (brgr needs one as its source).
// launchd runs `me autostart run` once at login; Herdr's own LaunchAgent starts the Herdr server.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LABEL = "dev.me.autostart";
export const PANE_LABEL = "me kernel";
export const plistPath = (home = homedir()) => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

export type Pane = { paneId: string; label: string | null; procs: { argv: string[]; cwd: string; pid: number }[] };

/** The LaunchAgent: one run at login (no KeepAlive; the kernel lives in Herdr, not under launchd). */
export function plist(o: { bun: string; root: string; config: string; path: string; log: string }): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const args = [o.bun, join(o.root, "bin", "me.ts"), "autostart", "run", "--config", o.config].map((a) => `    <string>${esc(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(o.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(o.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(o.log)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(o.log)}</string>
</dict>
</plist>
`;
}

/**
 * What to do, given the panes Herdr reports: the kernel already runs somewhere → wait for it;
 * an idle pane labelled "me kernel" exists (left from a previous login) → reuse it; else open a new workspace.
 */
export function decide(panes: Pane[], root: string, config: string): { kind: "running"; paneId: string } | { kind: "reuse"; paneId: string } | { kind: "create" } {
  // Same repository and same config file: a kernel started with another config (e.g. a test one) is a different me.
  const want = resolve(root, config);
  const isKernel = (x: Pane["procs"][number]) => {
    const at = x.argv.indexOf("start");
    return x.argv.includes("bin/me.ts") && at >= 0 && resolve(x.cwd, x.argv[at + 1] ?? "me.config.json") === want;
  };
  for (const p of panes) if (p.procs.some(isKernel)) return { kind: "running", paneId: p.paneId };
  // Herdr lists the pane's login shell (-zsh) as a foreground process, so a shell alone counts as idle.
  const shell = (x: Pane["procs"][number]) => /^-|^(zsh|bash|fish|sh)$/.test(x.argv[0] ?? "");
  const idle = panes.find((p) => p.label === PANE_LABEL && p.procs.every(shell));
  return idle ? { kind: "reuse", paneId: idle.paneId } : { kind: "create" };
}

type Log = (line: string) => void;
const herdr = (args: string[]): any => {
  const r = Bun.spawnSync(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`herdr ${args.join(" ")}: ${new TextDecoder().decode(r.stderr).trim() || r.exitCode}`);
  const out = new TextDecoder().decode(r.stdout).trim();
  return out.startsWith("{") ? JSON.parse(out) : out;
};

async function healthy(port: number) {
  return fetch(`http://127.0.0.1:${port}/api/bootstrap`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
}

async function until(what: string, ms: number, check: () => Promise<boolean> | boolean) {
  for (let t = 0; t < ms; t += 1000) {
    if (await check()) return;
    await Bun.sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function panes(): Pane[] {
  const list = herdr(["pane", "list"]);
  return (list?.result?.panes ?? []).map((p: any) => ({
    paneId: p.pane_id,
    label: p.label ?? null,
    procs: herdr(["pane", "process-info", "--pane", p.pane_id])?.result?.process_info?.foreground_processes ?? [],
  }));
}

/** Starts the kernel unless it already answers on the web port. Never stops or restarts anything. */
export async function run(o: { root: string; config: string; port: number; log?: Log; herdrWaitMs?: number; healthWaitMs?: number }) {
  const log = o.log ?? ((l: string) => console.log(`[autostart ${new Date().toISOString()}] ${l}`));
  if (await healthy(o.port)) return log(`me already answers on ${o.port}; nothing to do`), "already-running";

  log("waiting for the Herdr server");
  await until("the Herdr server", o.herdrWaitMs ?? 120_000, () => {
    try {
      return /status: running/.test(String(herdr(["status", "server"])));
    } catch {
      return false;
    }
  });

  const d = decide(panes(), o.root, o.config);
  let paneId: string;
  if (d.kind === "running") {
    log(`the kernel is already starting in ${d.paneId}`);
    paneId = d.paneId;
  } else {
    if (d.kind === "reuse") paneId = d.paneId;
    else {
      const ws = herdr(["workspace", "create", "--label", PANE_LABEL, "--cwd", o.root, "--no-focus"]);
      const wsId = ws?.result?.workspace?.workspace_id;
      paneId = herdr(["pane", "list", "--workspace", wsId])?.result?.panes?.[0]?.pane_id;
      if (!paneId) throw new Error(`no pane in the new workspace ${wsId}`);
    }
    herdr(["pane", "rename", paneId, PANE_LABEL]);
    herdr(["pane", "run", paneId, `cd ${JSON.stringify(o.root)} && bun bin/me.ts start ${JSON.stringify(o.config)}`]);
    log(`started the kernel in ${paneId} (${d.kind === "reuse" ? "reused pane" : `new workspace '${PANE_LABEL}'`})`);
  }
  await until(`me on port ${o.port}`, o.healthWaitMs ?? 120_000, () => healthy(o.port));
  log(`me answers on ${o.port}`);
  return d.kind === "running" ? "was-starting" : "started";
}

export function install(o: { root: string; config: string; log?: Log; home?: string }) {
  const log = o.log ?? console.log;
  const path = plistPath(o.home);
  const meHome = join(o.home ?? homedir(), ".me");
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(meHome, { recursive: true });
  writeFileSync(path, plist({ bun: process.execPath, root: o.root, config: o.config, path: process.env.PATH ?? "/usr/bin:/bin", log: join(meHome, "autostart.log") }));
  log(`wrote ${path}`);
  log("next login starts me in a Herdr pane; to load it now (runs once, does nothing while me is up): launchctl bootstrap gui/$(id -u) " + path);
  return path;
}

export function uninstall(o: { log?: Log; home?: string } = {}) {
  const log = o.log ?? console.log;
  const path = plistPath(o.home);
  if (!existsSync(path)) return log("not installed"), false;
  Bun.spawnSync(["launchctl", "bootout", `gui/${process.getuid?.()}`, path], { stdout: "ignore", stderr: "ignore" });
  rmSync(path);
  log(`removed ${path}`);
  return true;
}
