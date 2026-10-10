// Turns raw probe output into observations. Pure, so each rule is testable without the real tools.
import type { Observation, Status } from "./check.ts";

const obs = (status: Status, detail: string, latencyMs: number): Observation => ({ status, detail: detail.slice(0, 300), latencyMs });
const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() ?? "";

/** `ps -axo pid=,command=` output: up if any line other than our own ps matches the substring. */
export function interpretProcessList(stdout: string, match: string, ownPids: number[], latencyMs: number): Observation {
  const hits: number[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (ownPids.includes(pid)) continue;
    if (m[2]!.includes(match)) hits.push(pid);
  }
  if (hits.length === 0) return obs("down", `no process matches "${match}"`, latencyMs);
  const shown = hits.slice(0, 5).join(", ") + (hits.length > 5 ? ", …" : "");
  return obs("up", `${hits.length} process${hits.length > 1 ? "es" : ""} (pid ${shown})`, latencyMs);
}

/**
 * `launchctl print gui/<uid>/<label>`. Exit 113 (or "Could not find service") means the job is not loaded.
 * A loaded job is up only while `state = running`.
 */
export function interpretLaunchctl(code: number, stdout: string, stderr: string, latencyMs: number): Observation {
  const text = `${stdout}\n${stderr}`;
  if (code === 113 || /could not find service/i.test(text)) return obs("down", "launchd job not loaded", latencyMs);
  if (code !== 0) return obs("unknown", `launchctl exited ${code}: ${firstLine(stderr || stdout)}`, latencyMs);
  const field = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, "m").exec(stdout)?.[1]?.trim();
  const state = field("state");
  const pid = field("pid");
  const lastExit = field("last exit code");
  if (state === "running") return obs("up", `running${pid ? ` (pid ${pid})` : ""}`, latencyMs);
  if (!state) return obs("unknown", "launchctl output had no state", latencyMs);
  return obs("down", `${state}${lastExit ? `, last exit ${lastExit}` : ""}`, latencyMs);
}

/** `herdr pane get <id>` prints JSON: {result:{pane:{...}}} on success, {error:{code,message}} otherwise. */
export function interpretHerdrPane(code: number, stdout: string, stderr: string, latencyMs: number): Observation {
  let body: any = null;
  try {
    body = JSON.parse(stdout);
  } catch {
    // fall through
  }
  const pane = body?.result?.pane;
  if (code === 0 && pane) {
    const agent = pane.agent ? `${pane.agent}${pane.agent_status ? ` ${pane.agent_status}` : ""}` : "no agent";
    const title = pane.terminal_title_stripped || pane.terminal_title || "";
    return obs("up", title ? `${agent} · ${title}` : agent, latencyMs);
  }
  if (body?.error?.code === "pane_not_found") return obs("down", "pane not found", latencyMs);
  const why = body?.error?.message ?? firstLine(stderr || stdout) ?? "";
  return obs("unknown", `herdr exited ${code}${why ? `: ${why}` : ""}`, latencyMs);
}

/** A command check is up when it exits with the expected code. */
export function interpretCommand(code: number, expectExit: number, stdout: string, stderr: string, latencyMs: number): Observation {
  const out = firstLine(stdout) || firstLine(stderr);
  const detail = `exit ${code}${out ? `: ${out}` : ""}`;
  return obs(code === expectExit ? "up" : "down", detail, latencyMs);
}
