// 운영: what is running right now, per-machine checks, and plugin health.
import { useState } from "react";
import type { OpsCheck, PluginInfo } from "./api.ts";
import { useApp } from "./context.ts";
import { Header, Section, StatusDot, elapsed, timeAgo, useNow } from "./shared.tsx";
import { activeOps, type Tone } from "./state.ts";

const CHECK_LABEL: Record<OpsCheck["status"], string> = { up: "정상", down: "응답 없음", unknown: "알 수 없음" };
const CHECK_ORDER: Record<OpsCheck["status"], number> = { down: 0, unknown: 1, up: 2 };
const CHECK_TONE: Record<OpsCheck["status"], Tone> = { up: "done", down: "failed", unknown: "needs" };

const machineOf = (source?: string) => (!source || source === "ops" ? "이 Mac" : source.replace(/^ops-/, ""));

/** Down checks plus plugins that are not running: the ops tab badge. */
export function downCount(checks: OpsCheck[], plugins: PluginInfo[]) {
  return checks.filter((c) => c.status === "down").length + plugins.filter((p) => p.state === "stopped" || p.state === "quarantined").length;
}

export function OpsScreen() {
  const { s } = useApp();
  const checks = Object.values(s.checks);
  const plugins = Object.values(s.plugins).sort((a, b) => a.id.localeCompare(b.id));
  return (
    <div className="page">
      <Header title="운영">
        {s.viewer && (
          <span className="bar-meta" title={`Tailscale로 접속: ${s.viewer.login}`}>
            {s.viewer.name}
          </span>
        )}
      </Header>
      <div className="pane-scroll page-body">
        <RunningNow />
        <Machines checks={checks} />
        <Section label="플러그인" count={plugins.length}>
          {plugins.length === 0 ? (
            <p className="muted pad">플러그인 정보가 아직 없어요.</p>
          ) : (
            <ul className="rows boxed">
              {plugins.map((p) => (
                <PluginRow key={p.id} p={p} />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function RunningNow() {
  const { s } = useApp();
  const now = useNow();
  const ops = activeOps(s);
  return (
    <Section label="지금 돌고 있는 것" count={ops.length}>
      {ops.length === 0 ? (
        <p className="muted pad">지금 진행 중인 작업이 없어요.</p>
      ) : (
        <ul className="rows boxed">
          {ops.map((o) => (
            <li key={o.opId} className="op-row">
              <StatusDot tone={o.state === "waiting" ? "needs" : "running"} hideLabel />
              <span className="row-main">
                <span className="row-title">
                  {o.caller} → {o.callee} · <span className="mono">{o.method}</span>
                </span>
                <span className="row-sub">
                  <span className={`tone-text tone-${o.state === "waiting" ? "needs" : "running"}`}>{o.phaseLabel ?? (o.state === "waiting" ? "대기 중" : "진행 중")}</span> ·{" "}
                  {elapsed(o.startedAt, null, now)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** One group per machine; machines with something down come first. Healthy checks are chips, problems are cards. */
function Machines({ checks }: { checks: OpsCheck[] }) {
  if (checks.length === 0)
    return (
      <Section label="기기">
        <p className="muted pad">등록된 점검이 없어요.</p>
      </Section>
    );
  const groups = new Map<string, OpsCheck[]>();
  for (const c of checks) groups.set(machineOf(c.source), [...(groups.get(machineOf(c.source)) ?? []), c]);
  const ordered = [...groups.entries()].sort(
    ([a, xs], [b, ys]) =>
      Math.min(...xs.map((c) => CHECK_ORDER[c.status])) - Math.min(...ys.map((c) => CHECK_ORDER[c.status])) || a.localeCompare(b),
  );
  const down = checks.filter((c) => c.status === "down").length;
  return (
    <Section label="기기" count={down || undefined} tone={down ? "failed" : undefined}>
      {ordered.map(([machine, list]) => (
        <div key={machine} className="machine">
          <div className="machine-label">
            {machine} · {list.filter((c) => c.status === "up").length}/{list.length} 정상
          </div>
          {list.some((c) => c.status === "up") && (
            <div className="up-chips" role="group" aria-label="정상">
              {list
                .filter((c) => c.status === "up")
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((c) => (
                  <span key={`${c.source ?? "ops"}/${c.id}`} className="up-chip" title={`${c.kind} · ${c.latencyMs}ms · ${c.detail}`}>
                    <StatusDot tone="done" hideLabel />
                    {c.id}
                  </span>
                ))}
            </div>
          )}
          {[...list]
            .filter((c) => c.status !== "up")
            .sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status] || a.id.localeCompare(b.id))
            .map((c) => (
              <div key={`${c.source ?? "ops"}/${c.id}`} className={`card check check-${c.status}`}>
                <div className="card-head">
                  <StatusDot tone={CHECK_TONE[c.status]} label={CHECK_LABEL[c.status]} />
                  <strong>{c.id}</strong>
                  <span className="muted">{c.kind}</span>
                  <span className="muted right" title={`마지막 확인 ${new Date(c.checkedAt).toLocaleString()}`}>
                    {timeAgo(c.since) === "방금" ? "방금 전부터" : `${timeAgo(c.since)}부터`}
                  </span>
                </div>
                <div className="check-detail">{c.detail}</div>
              </div>
            ))}
        </div>
      ))}
    </Section>
  );
}

const PLUGIN_STATUS: Record<PluginInfo["state"], [Tone, string]> = {
  running: ["done", "실행 중"],
  starting: ["running", "시작 중"],
  stopped: ["failed", "멈춤"],
  quarantined: ["failed", "격리됨"],
};
const MODE_LABEL: Record<string, string> = { spawned: "자식 프로세스", attached: "내장", connected: "외부 연결" };

function PluginRow({ p }: { p: PluginInfo }) {
  const [open, setOpen] = useState(false);
  const [tone, label] = PLUGIN_STATUS[p.state] ?? ["none", p.state];
  return (
    <li className={`plugin${open ? " open" : ""}`}>
      <button className="plugin-row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <StatusDot tone={tone} hideLabel />
        <span className="row-main">
          <span className="row-title">
            {p.id}
            {(p.activeOps ?? 0) > 0 && <span className="tag">작업 {p.activeOps}개</span>}
          </span>
          <span className="row-sub">
            <span className={`tone-text tone-${tone}`}>{label}</span> · v{p.version}
            {p.restarts > 0 && ` · 재시작 ${p.restarts}회`}
          </span>
          {p.lastError && (
            <span className="row-note bad">
              {p.lastError.method}: {p.lastError.message}
            </span>
          )}
        </span>
        <span className="chev" aria-hidden="true">
          {open ? "⌃" : "⌄"}
        </span>
      </button>
      {open && (
        <div className="plugin-more">
          <dl className="facts">
            <div>
              <dt>버전</dt>
              <dd>{p.version}</dd>
            </div>
            <div>
              <dt>pid</dt>
              <dd>{p.pid ?? "-"}</dd>
            </div>
            <div>
              <dt>모드</dt>
              <dd>{p.mode ? (MODE_LABEL[p.mode] ?? p.mode) : "-"}</dd>
            </div>
            {p.remote && (
              <div>
                <dt>원격 주소</dt>
                <dd className="mono">
                  {p.remote.address}:{p.remote.port}
                </dd>
              </div>
            )}
            <div>
              <dt>재시작</dt>
              <dd>{p.restarts}회</dd>
            </div>
            {p.lastError && (
              <div>
                <dt>마지막 오류</dt>
                <dd>{timeAgo(p.lastError.at)}</dd>
              </div>
            )}
          </dl>
          <div className="perms">{p.permissions.length ? p.permissions.map((perm) => <span key={perm}>{perm}</span>) : <span>권한 없음</span>}</div>
        </div>
      )}
    </li>
  );
}
