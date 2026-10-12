// 상태: is everything fine, per-machine checks, what each part of me does, projects; raw diagnostics folded.
// A failing check card offers its configured actions; pressing one asks for approval (the card shows up in 작업).
import { useState } from "react";
import type { HeadAlert, OpsCheck, PluginInfo } from "./api.ts";
import { useApp } from "./context.ts";
import { HarnessLink } from "./harness.tsx";
import { ProjectsSection } from "./projects.tsx";
import { taskHref } from "./routes.ts";
import { Header, Section, StatusDot, elapsed, timeAgo, useBusy, useNow } from "./shared.tsx";
import { activeAlerts, activeOps, type Tone } from "./state.ts";

/** What the ops plugin adds to a check record when the check declares actions (plugins/ops domain/action.ts). */
interface CheckAction {
  id: string;
  label: string;
  argv: string[];
  risk: "medium" | "high";
}
interface ActionRun {
  actionId: string;
  label: string;
  argv: string[];
  machine: string;
  state: "waiting" | "running" | "done" | "failed" | "rejected";
  requestedAt: string;
  finishedAt?: string;
  exitCode?: number;
  timedOut?: boolean;
  output?: string;
  note?: string;
  recheck?: { status: OpsCheck["status"]; detail: string; checkedAt: string };
}
type Check = OpsCheck & { actions?: CheckAction[]; lastAction?: ActionRun | null };

const RUN_STATUS: Record<ActionRun["state"], [Tone, string]> = {
  waiting: ["needs", "승인 대기"],
  running: ["running", "실행 중"],
  done: ["done", "완료"],
  failed: ["failed", "실패"],
  rejected: ["muted", "거절됨"],
};
const busyRun = (r?: ActionRun | null) => r?.state === "waiting" || r?.state === "running";
/** A check that recovered after an action keeps its card this long, so the result stays readable. */
const RECENT_RUN_MS = 10 * 60_000;
const showsCard = (c: Check, now: number) => {
  const r = c.lastAction;
  return c.status !== "up" || busyRun(r) || (!!r && now - Date.parse(r.finishedAt ?? r.requestedAt) < RECENT_RUN_MS);
};

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
      <Header title="상태">
        {s.viewer && (
          <span className="bar-meta" title={`Tailscale로 접속: ${s.viewer.login}`}>
            {s.viewer.name}
          </span>
        )}
      </Header>
      <div className="pane-scroll page-body">
        <AlertsCard />
        <Summary checks={checks} plugins={plugins} />
        <Machines checks={checks} />
        <Parts plugins={plugins} />
        <ProjectsSection />
        <HarnessLink />
        <details className="fold advanced">
          <summary>고급 진단</summary>
          <RunningNow />
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
        </details>
      </div>
    </div>
  );
}

/** Blocked replies and delegations: the cause and the exact fix, until the same thing succeeds. */
function AlertsCard() {
  const { s } = useApp();
  const alerts = activeAlerts(s);
  if (alerts.length === 0) return null;
  return (
    <Section label="해야 할 일" count={alerts.length} tone="needs">
      <ul className="rows boxed">
        {alerts.map((a: HeadAlert) => (
          <li key={a.id} className="part-row alert-row">
            <span className="row-main">
              <StatusDot tone="needs" label="막힘" />
              <span className="row-title">{a.title}</span>
              <span className="row-sub">{a.fix}</span>
              {a.detail && (
                <span className="row-sub muted" title={a.detail}>
                  {a.detail.slice(0, 120)}
                </span>
              )}
              <span className="row-sub muted">{timeAgo(a.updatedAt)}</span>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The one line that answers "is me OK?", with when that was last checked. */
function Summary({ checks, plugins }: { checks: OpsCheck[]; plugins: PluginInfo[] }) {
  const problems = downCount(checks, plugins);
  const last = checks.map((c) => c.checkedAt).sort().at(-1);
  // No check has run yet: say so rather than claim everything is fine.
  const [tone, label]: [Tone, string] = problems ? ["failed", `점검이 필요해요 · ${problems}곳`] : last ? ["done", "모든 시스템 정상"] : ["none", "점검 기록이 아직 없어요"];
  return (
    <div className="card summary">
      <StatusDot tone={tone} label={label} />
      <p className="muted summary-sub">
        {last ? `마지막 확인 ${timeAgo(last)} · ` : "기기 점검(ops 플러그인)이 결과를 보내면 여기에 떠요 · "}이 화면은 웹 연결이 살아 있을 때만 새로 고쳐져요
      </p>
    </div>
  );
}

/** What each plugin does for the user, in words; ids stay in 고급 진단. */
const ROLE: Record<string, string> = {
  "gjc-head": "대화 엔진",
  jev: "응답 판단",
  slang: "말 풀이",
  summarize: "지시서 작성",
  brgr: "워커 실행기",
  "approval-policy": "자동 승인 규칙",
  web: "웹 화면",
  ops: "기기 점검",
  "harness-config": "실행 도구 설정",
};

function Parts({ plugins }: { plugins: PluginInfo[] }) {
  if (plugins.length === 0) return null;
  const rows = plugins.map((p) => ({ p, role: ROLE[p.id] ?? (p.id.startsWith("ops-") ? `기기 점검 (${p.id.slice(4)})` : p.id) }));
  const bad = plugins.filter((p) => p.state === "stopped" || p.state === "quarantined").length;
  return (
    <Section label="구성 요소" count={bad || undefined} tone={bad ? "failed" : undefined}>
      <ul className="rows boxed">
        {rows
          .sort((a, b) => a.role.localeCompare(b.role, "ko"))
          .map(({ p, role }) => {
            const [tone, label] = PLUGIN_STATUS[p.state] ?? ["none", p.state];
            return (
              <li key={p.id} className="part-row">
                <span className="row-title">{role}</span>
                <StatusDot tone={tone} label={label} />
              </li>
            );
          })}
      </ul>
    </Section>
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
function Machines({ checks }: { checks: Check[] }) {
  const now = useNow(30_000);
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
          {list.some((c) => !showsCard(c, now)) && (
            <div className="up-chips" role="group" aria-label="정상">
              {list
                .filter((c) => !showsCard(c, now))
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
            .filter((c) => showsCard(c, now))
            .sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status] || a.id.localeCompare(b.id))
            .map((c) => (
              <CheckCard key={`${c.source ?? "ops"}/${c.id}`} c={c} />
            ))}
        </div>
      ))}
    </Section>
  );
}

/** A check that is not up (or has an action in flight): status, detail, its actions and the last action's result. */
function CheckCard({ c }: { c: Check }) {
  const { conn, notify } = useApp();
  const [busy, act] = useBusy(notify);
  const actions = c.actions ?? [];
  const last = c.lastAction;
  const run = (a: CheckAction) =>
    act(async () => {
      if (!conn) return;
      // Only ids go to the server; the ops instance looks up the argv in its own config.
      await conn.request("ops.action.run", { source: c.source ?? "ops", checkId: c.id, actionId: a.id });
      notify(`'${a.label}' 승인을 요청했어요. 작업 탭에서 승인하면 실행돼요.`);
    });
  return (
    <div className={`card check check-${c.status}`}>
      <div className="card-head">
        <StatusDot tone={CHECK_TONE[c.status]} label={CHECK_LABEL[c.status]} />
        <strong>{c.id}</strong>
        <span className="muted">{c.kind}</span>
        <span className="muted right" title={`마지막 확인 ${new Date(c.checkedAt).toLocaleString()}`}>
          {timeAgo(c.since) === "방금" ? "방금 전부터" : `${timeAgo(c.since)}부터`}
        </span>
      </div>
      <div className="check-detail">{c.detail}</div>
      {actions.length > 0 && c.status !== "up" && (
        <>
          <div className="actions-row" role="group" aria-label={`${c.id} 조치`}>
            {actions.map((a) => (
              <button key={a.id} disabled={busy || !conn || busyRun(last)} onClick={() => run(a)}>
                {a.label}
              </button>
            ))}
          </div>
          <details className="fold">
            <summary>누르면 실행할 명령 · 승인 후에만 실행돼요</summary>
            {actions.map((a) => (
              <p key={a.id} className="brief">
                {a.label}
                {a.risk === "high" ? " (위험 높음)" : ""}: <span className="mono">{a.argv.join(" ")}</span>
              </p>
            ))}
          </details>
        </>
      )}
      {last && <LastAction run={last} />}
    </div>
  );
}

function LastAction({ run }: { run: ActionRun }) {
  const [tone, label] = RUN_STATUS[run.state] ?? ["none", run.state];
  const when = run.finishedAt ?? run.requestedAt;
  const facts = [
    run.exitCode !== undefined && !run.timedOut ? `종료 코드 ${run.exitCode}` : null,
    run.recheck ? `다시 확인: ${CHECK_LABEL[run.recheck.status] ?? run.recheck.status}` : null,
  ].filter(Boolean);
  return (
    <>
      <p className="result-note">
        <StatusDot tone={tone} label={label} /> 마지막 조치 '{run.label}' · {timeAgo(when)}
        {facts.length > 0 && ` · ${facts.join(" · ")}`}
      </p>
      {run.note && <p className="result-note muted">{run.note}</p>}
      {run.state === "waiting" && (
        <p className="result-note">
          <a className="link" href={taskHref()}>
            작업 탭에서 승인하기 ›
          </a>
        </p>
      )}
      {run.output && (
        <details className="fold">
          <summary>출력</summary>
          <p className="brief check-detail">{run.output}</p>
        </details>
      )}
    </>
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
