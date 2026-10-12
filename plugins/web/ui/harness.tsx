// 실행 도구 설정: one source (MCP servers, instructions, skills, hooks) into each coding harness.
// Source edits land in source.json at once; harness files change only through 미리보기 → 적용,
// which asks the kernel approval gate (작업 탭에서 승인) before writing anything.
import { useCallback, useEffect, useState } from "react";
import { useApp } from "./context.ts";
import { harnessHref, taskHref } from "./routes.ts";
import { Empty, Header, Section, StatusDot, toolName, useBusy, useFocusTrap } from "./shared.tsx";
import type { Tone } from "./state.ts";

const HARNESS_IDS = ["claude-code", "codex", "opencode", "gjc"] as const;
const SHORT: Record<string, string> = { "claude-code": "Claude", codex: "Codex", opencode: "OpenCode", gjc: "GJC" };
const short = (h: string) => SHORT[h] ?? h;

type Share = "all" | string[];
const sharedList = (share: Share | undefined): string[] => (share === "all" ? [...HARNESS_IDS] : (share ?? []));
/** Toggling one harness; null when the last one would turn off. All four on folds back to "all". */
const toggleShare = (share: Share, id: string): Share | null => {
  const cur = new Set(sharedList(share));
  if (cur.has(id)) cur.delete(id);
  else cur.add(id);
  if (cur.size === 0) return null;
  return cur.size === HARNESS_IDS.length ? "all" : HARNESS_IDS.filter((h) => cur.has(h));
};

interface ServerView {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  share: Share;
  scope?: string;
}
interface SourceView {
  mcpServers: Record<string, ServerView>;
  instructions: Record<string, { file: string; share: Share }>;
  skills: Record<string, { dir: string; share: Share }>;
  hooks: Record<string, { event: string; command: string; share: Share }>;
}
interface FileEntry {
  target: string;
  path: string;
  exists: boolean;
  managed?: string[];
  unmanaged?: string[];
  error?: string;
}
interface DiffView {
  added: { name: string; after: Record<string, unknown> }[];
  changed: { name: string; fields: { field: string }[] }[];
  removed: { name: string }[];
}
interface TargetPlan {
  target: string;
  harness: string;
  diff: DiffView;
  error?: string;
}
interface PlanView {
  planId: string;
  ok: boolean;
  changes: number;
  targets: TargetPlan[];
}
interface Conflict {
  targets: string[];
  fields: string[];
}
interface ImportDry {
  conflicts: Record<string, Conflict>;
  counts: Record<string, { entries?: number; error?: string }>;
}

const SECTION_LABEL: Record<string, string> = { mcpServers: "외부 도구", instructions: "지시문", skills: "스킬", hooks: "후크" };
const sectionOf = (target: string) => {
  const rest = target.split(":")[1] ?? "";
  return rest === "user" || rest === "project" ? "외부 도구" : (SECTION_LABEL[rest] ?? "설정");
};
/** claude-code:user → Claude Code, claude-code:project → Claude Code · 프로젝트, codex:hooks → Codex · 후크. */
const targetLabel = (target: string) => {
  const [h, rest] = target.split(":");
  const base = toolName(h ?? target);
  if (rest === "project") return `${base} · 프로젝트`;
  if (rest && rest !== "user") return `${base} · ${SECTION_LABEL[rest] ?? rest}`;
  return base;
};

export function HarnessScreen({ fake }: { fake: string | null }) {
  if (fake) return <FakeHarness kind={fake} />;
  return <LiveHarness />;
}

function LiveHarness() {
  const { conn, notify, s } = useApp();
  const [source, setSource] = useState<{ exists: boolean; source: SourceView } | null>(null);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, act] = useBusy(notify);
  const [editing, setEditing] = useState<{ name: string } | { fresh: true } | null>(null);
  const [sheet, setSheet] = useState(false);
  const [importDry, setImportDry] = useState<ImportDry | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [skipImport, setSkipImport] = useState(false);
  const [awaitApply, setAwaitApply] = useState(false);

  const refresh = useCallback(async () => {
    if (!conn) return null;
    const [g, l] = await Promise.all([conn.request("harness.source.get"), conn.request("harness.list")]);
    setSource({ exists: g.exists, source: g.source });
    setFiles(l.files);
    let p: PlanView | null = null;
    try {
      p = await conn.request("harness.plan");
    } catch {
      p = null;
    }
    setPlan(p);
    return p;
  }, [conn]);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    refresh().catch((err: Error) => alive && setLoadError(err.message));
    return () => {
      alive = false;
    };
  }, [refresh]);

  // The approval lives in 작업; when it is decided (either way), reread and say what happened.
  const approvalsKey = Object.keys(s.approvals).sort().join(",");
  useEffect(() => {
    if (!awaitApply) return;
    if (Object.values(s.approvals).some((a) => a.requester === "harness-config")) return;
    setAwaitApply(false);
    refresh()
      .then((p) => p && notify(p.changes === 0 ? "적용됐어요" : "아직 바뀜이 남아 있어요. 미리보기를 다시 확인해 주세요."))
      .catch((err: Error) => notify(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitApply, approvalsKey]);

  const update = (op: string, name: string, extra: Record<string, unknown>, ok: string) =>
    act(async () => {
      if (!conn) return;
      await conn.request("harness.source.update", { op, name, ...extra });
      await refresh();
      notify(ok);
    });

  const onToggle = (name: string, id: string, share: Share) => {
    const next = toggleShare(share, id);
    if (!next) {
      notify("하나 이상 켜야 해요");
      return;
    }
    void update("setShare", name, { share: next }, "바꿨어요");
  };

  const onApplyRequest = () =>
    act(async () => {
      if (!conn) return;
      const res = await conn.request("harness.apply.request");
      if (!res.requested) {
        notify("바뀔 게 없어요");
        return;
      }
      setSheet(false);
      setAwaitApply(true);
      notify("작업 탭에서 승인하면 적용돼요");
    });

  if (loadError)
    return (
      <div className="page">
        <Header title="실행 도구 설정" back="#/settings" />
        <div className="pane-scroll page-body">
          <div className="card error">⚠️ {loadError}</div>
        </div>
      </div>
    );
  if (!source || !files)
    return (
      <div className="page">
        <Header title="실행 도구 설정" back="#/settings" />
        <div className="pane-scroll page-body">
          <p className="muted">불러오는 중…</p>
        </div>
      </div>
    );

  const showImport = !source.exists && !skipImport;
  return (
    <div className="page">
      <Header title="실행 도구 설정" back="#/settings" />
      <div className="pane-scroll page-body">
        {showImport && (
          <ImportCard
            dry={importDry}
            resolutions={resolutions}
            busy={busy}
            onPick={(k, t) => setResolutions((r) => ({ ...r, [k]: t }))}
            onLoad={() =>
              act(async () => {
                if (!conn) return;
                setImportDry(await conn.request("harness.import", {}));
              })
            }
            onSkip={() => setSkipImport(true)}
            onAdopt={() =>
              act(async () => {
                if (!conn) return;
                await conn.request("harness.import", { write: true });
                const res = await conn.request("harness.draft.adopt", { resolutions });
                setImportDry(null);
                await refresh();
                notify(`가져왔어요 · ${res.adopted.length}개 골랐어요`);
              })
            }
          />
        )}
        <HarnessCards files={files} />
        <McpList
          source={source.source}
          busy={busy}
          onToggle={onToggle}
          onEdit={(name) => setEditing({ name })}
          onAdd={() => setEditing({ fresh: true })}
        />
        <SkillsHooks source={source.source} />
        {awaitApply && (
          <p className="result-note">
            승인 대기 중 ·{" "}
            <a className="link" href={taskHref()}>
              작업 탭에서 승인하기 ›
            </a>
          </p>
        )}
      </div>
      {plan && plan.changes > 0 && !sheet && (
        <div className="apply-bar">
          <span>{plan.changes}개 바뀜</span>
          <button className="primary" disabled={busy} onClick={() => setSheet(true)}>
            미리보기
          </button>
        </div>
      )}
      {sheet && plan && <DiffSheet plan={plan} busy={busy} onClose={() => setSheet(false)} onApply={onApplyRequest} />}
      {editing && (
        <ServerSheet
          name={"name" in editing ? editing.name : null}
          srv={"name" in editing ? (source.source.mcpServers[editing.name] ?? null) : null}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(fields) =>
            act(async () => {
              if (!conn) return;
              const n = "name" in editing && editing.name ? editing.name : fields.name.trim();
              await conn.request("harness.source.update", { op: "upsert", name: n, server: fields.server });
              setEditing(null);
              await refresh();
              notify("저장했어요");
            })
          }
          onRemove={
            "name" in editing
              ? () =>
                  act(async () => {
                    if (!conn) return;
                    await conn.request("harness.source.update", { op: "remove", name: editing.name });
                    setEditing(null);
                    await refresh();
                    notify("목록에서 뺐어요. 하네스 파일에 남은 건 그 앱에서 지워주세요.");
                  })
              : undefined
          }
        />
      )}
    </div>
  );
}

/** One card per harness: is its config file there, and how many items does me manage in it. */
function HarnessCards({ files }: { files: FileEntry[] }) {
  return (
    <Section label="실행 도구" count={HARNESS_IDS.length}>
      <ul className="rows boxed">
        {HARNESS_IDS.map((h) => {
          const user = files.find((f) => f.target === `${h}:user`);
          const skills = files.find((f) => f.target === `${h}:skills`);
          const managed = (user?.managed?.length ?? 0) + (skills?.managed?.length ?? 0);
          const [tone, label]: [Tone, string] = user?.exists ? ["done", "있음"] : ["muted", "없음"];
          return (
            <li key={h} className="part-row">
              <span className="row-main">
                <span className="row-title">{toolName(h)}</span>
                <span className="row-sub">{user?.exists ? `me 관리 ${managed}개` : "설정 파일이 없어요"}</span>
              </span>
              <StatusDot tone={tone} label={label} />
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function McpList({
  source,
  busy,
  onToggle,
  onEdit,
  onAdd,
}: {
  source: SourceView;
  busy: boolean;
  onToggle: (name: string, id: string, share: Share) => void;
  onEdit: (name: string) => void;
  onAdd: () => void;
}) {
  const entries = Object.entries(source.mcpServers).sort(([a], [b]) => a.localeCompare(b));
  return (
    <Section label="외부 도구 연결(MCP)" count={entries.length}>
      {entries.length === 0 ? (
        <Empty title="아직 서버가 없어요">아래에서 추가하면 각 앱에 넣어줘요.</Empty>
      ) : (
        <ul className="rows boxed">
          {entries.map(([name, srv]) => (
            <ServerRow key={name} name={name} srv={srv} busy={busy} onToggle={onToggle} onEdit={() => onEdit(name)} />
          ))}
        </ul>
      )}
      <div className="pad">
        <button disabled={busy} onClick={onAdd}>
          + 외부 도구 추가
        </button>
      </div>
    </Section>
  );
}

/** Per-tool switches: a real checkbox with the visible label "이 도구에서 쓰기", plus a separate dot+text status. Reused by the server list and the add/edit sheet. */
function ShareToggles({ share, busy, onToggle }: { share: Share; busy: boolean; onToggle: (id: string) => void }) {
  return (
    <div className="share-list" role="group" aria-label="어느 앱에 넣을지">
      {HARNESS_IDS.map((h) => {
        const on = sharedList(share).includes(h);
        return (
          <div key={h} className="share-row">
            <span className="share-tool">{short(h)}</span>
            <StatusDot tone={on ? "done" : "muted"} label={on ? "사용 중" : "사용 안 함"} />
            <label className="share-toggle">
              <input type="checkbox" checked={on} disabled={busy} onChange={() => onToggle(h)} aria-label={`${short(h)}: 이 도구에서 쓰기`} />
              이 도구에서 쓰기
            </label>
          </div>
        );
      })}
    </div>
  );
}

function ServerRow({
  name,
  srv,
  busy,
  onToggle,
  onEdit,
}: {
  name: string;
  srv: ServerView;
  busy: boolean;
  onToggle: (name: string, id: string, share: Share) => void;
  onEdit: () => void;
}) {
  return (
    <li className="server-row">
      <button className="server-main" disabled={busy} onClick={onEdit} aria-label={`${name} 편집`}>
        <span className="row-main">
          <span className="row-title">
            {name} <span className="kind">{srv.url ? "URL" : "명령"}</span>
          </span>
          <span className="row-sub">{srv.url ?? srv.command ?? ""}</span>
        </span>
        <span className="chev" aria-hidden="true">
          ›
        </span>
      </button>
      <ShareToggles share={srv.share} busy={busy} onToggle={(h) => onToggle(name, h, srv.share)} />
    </li>
  );
}

/** No source yet: read the harness files, let clashes be picked per name, then take them in. */
function ImportCard({
  dry,
  resolutions,
  busy,
  onPick,
  onLoad,
  onSkip,
  onAdopt,
}: {
  dry: ImportDry | null;
  resolutions: Record<string, string>;
  busy: boolean;
  onPick: (key: string, target: string) => void;
  onLoad: () => void;
  onSkip: () => void;
  onAdopt: () => void;
}) {
  const conflicts = dry ? Object.entries(dry.conflicts).sort(([a], [b]) => a.localeCompare(b)) : [];
  const unresolved = conflicts.filter(([k]) => !dry?.conflicts[k]?.targets.includes(resolutions[k] ?? "")).length;
  const counts =
    dry &&
    HARNESS_IDS.map((h) => {
      const n = dry.counts[`${h}:user`];
      return `${short(h)} ${typeof n?.entries === "number" ? `${n.entries}개` : "?"}`;
    }).join(" · ");
  return (
    <div className="card import">
      <div className="card-head">
        <strong>지금 쓰는 설정 불러오기</strong>
      </div>
      <p className="brief">쓰던 외부 도구 설정을 읽어서 me가 관리하게 해요. 비밀은 따로 저장돼요.</p>
      {!dry ? (
        <div className="actions-row">
          <button className="primary" disabled={busy} onClick={onLoad}>
            불러오기
          </button>
          <button className="quiet" disabled={busy} onClick={onSkip}>
            건너뛰기
          </button>
        </div>
      ) : (
        <>
          {counts && <p className="result-note muted">읽은 설정 · {counts}</p>}
          {conflicts.length === 0 ? (
            <p className="result-note">겹치는 이름이 없어요. 그대로 가져오면 돼요.</p>
          ) : (
            <p className="result-note">이름이 겹쳐요. 쓸 것을 하나씩 골라주세요.</p>
          )}
          {conflicts.map(([key, c]) => (
            <div key={key} className="conflict">
              <p className="brief">
                <strong>{key.replace(/^instructions\./, "")}</strong>
                <span className="muted"> · 바뀐 곳 {c.fields.join(", ")}</span>
              </p>
              <div className="pick-list" role="radiogroup" aria-label={`${key}에 쓸 설정`}>
                {c.targets.map((t) => (
                  <label key={t} className={`pick-row${resolutions[key] === t ? " on" : ""}`}>
                    <input type="radio" name={`conflict-${key}`} checked={resolutions[key] === t} onChange={() => onPick(key, t)} />
                    <span className="pick-label">{targetLabel(t)}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="actions-row">
            <button className="primary" disabled={busy || unresolved > 0} onClick={onAdopt}>
              {unresolved > 0 ? `${unresolved}개 남았어요` : "가져오기"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface ServerFields {
  name: string;
  server: { kind: "command" | "url"; command?: string; args?: string[]; url?: string; env?: Record<string, string>; headers?: Record<string, string>; share: Share };
}

function ServerSheet({
  name,
  srv,
  busy,
  onClose,
  onSave,
  onRemove,
}: {
  name: string | null;
  srv: ServerView | null;
  busy: boolean;
  onClose: () => void;
  onSave: (f: ServerFields) => void;
  onRemove?: () => void;
}) {
  const [draft, setDraft] = useState(name ?? "");
  const [kind, setKind] = useState<"command" | "url">(srv?.url ? "url" : "command");
  const [command, setCommand] = useState(srv?.command ?? "");
  const [argsText, setArgsText] = useState((srv?.args ?? []).join(" "));
  const [url, setUrl] = useState(srv?.url ?? "");
  const [envRows, setEnvRows] = useState<[string, string][]>(() => Object.entries(srv?.env ?? {}).map(([k, v]): [string, string] => [k, hasRef(v) ? "" : v]));
  const [headerRows, setHeaderRows] = useState<[string, string][]>(() => Object.entries(srv?.headers ?? {}).map(([k, v]): [string, string] => [k, hasRef(v) ? "" : v]));
  const [share, setShare] = useState<Share>(srv?.share ?? "all");
  const [arming, setArming] = useState(false);
  const panel = useFocusTrap(onClose);

  const rows = (rs: [string, string][], set: (r: [string, string][]) => void, label: string, stored: boolean) => (
    <div className="kv">
      <p className="muted">
        {label}
        {stored && " · 비우면 기존 값을 유지해요"}
      </p>
      {rs.map(([k, v], i) => (
        <div key={i} className="kv-row">
          <input className="field-input" value={k} placeholder="이름" aria-label={`${label} 이름 ${i + 1}`} onChange={(e) => set(rs.map(([a, b], j): [string, string] => (j === i ? [e.target.value, b] : [a, b])))} />
          <input
            className="field-input"
            value={v}
            placeholder={stored && srv && (label === "환경 변수" ? srv.env?.[k] !== undefined : srv.headers?.[k] !== undefined) ? "저장됨" : "값"}
            aria-label={`${label} 값 ${i + 1}`}
            onChange={(e) => set(rs.map(([a, b], j): [string, string] => (j === i ? [a, e.target.value] : [a, b])))}
          />
          <button className="icon-btn" aria-label={`${label} ${i + 1} 지우기`} onClick={() => set(rs.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="link" onClick={() => set([...rs, ["", ""]])}>
        + 행 추가
      </button>
    </div>
  );

  const save = () => {
    const map = (rs: [string, string][]) => Object.fromEntries(rs.filter(([k]) => k.trim()).map(([k, v]): [string, string] => [k.trim(), v]));
    onSave({
      name: draft,
      server: {
        kind,
        ...(kind === "command" ? { command: command.trim(), args: argsText.split(/\s+/).filter(Boolean) } : { url: url.trim() }),
        ...(Object.keys(map(envRows)).length ? { env: map(envRows) } : {}),
        ...(Object.keys(map(headerRows)).length ? { headers: map(headerRows) } : {}),
        share,
      },
    });
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="server-title" ref={panel}>
        <header className="drawer-head">
          <h2 className="drawer-title" id="server-title">
            {name ?? "외부 도구 추가"}
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>
        <div className="drawer-body">
          {!name && (
            <label className="field">
              <span>이름</span>
              <input className="field-input" value={draft} placeholder="notion" aria-label="서버 이름" onChange={(e) => setDraft(e.target.value)} />
            </label>
          )}
          <fieldset className="pick">
            <legend>종류</legend>
            <div className="seg">
              <button className={`seg-item${kind === "command" ? " on" : ""}`} aria-pressed={kind === "command"} onClick={() => setKind("command")}>
                명령
              </button>
              <button className={`seg-item${kind === "url" ? " on" : ""}`} aria-pressed={kind === "url"} onClick={() => setKind("url")}>
                URL
              </button>
            </div>
          </fieldset>
          {kind === "command" ? (
            <>
              <label className="field">
                <span>명령</span>
                <input className="field-input" value={command} placeholder="bunx" aria-label="실행 명령" onChange={(e) => setCommand(e.target.value)} />
              </label>
              <label className="field">
                <span>인자</span>
                <input className="field-input" value={argsText} placeholder="띄어쓰기로 구분" aria-label="명령 인자" onChange={(e) => setArgsText(e.target.value)} />
              </label>
            </>
          ) : (
            <label className="field">
              <span>URL</span>
              <input className="field-input" value={url} placeholder="https://" aria-label="서버 URL" onChange={(e) => setUrl(e.target.value)} />
            </label>
          )}
          {rows(envRows, setEnvRows, "환경 변수", !!name)}
          {rows(headerRows, setHeaderRows, "헤더", !!name)}
          {!name && <p className="result-note muted">비밀처럼 보이면 따로 저장돼요.</p>}
          <div className="kv">
            <p className="muted">어느 앱에 넣을지</p>
            <ShareToggles
              share={share}
              busy={busy}
              onToggle={(h) => {
                const next = toggleShare(share, h);
                if (next) setShare(next);
              }}
            />
          </div>
        </div>
        <footer className="drawer-foot">
          {onRemove &&
            (arming ? (
              <button className="quiet" disabled={busy} onClick={onRemove}>
                정말 빼기
              </button>
            ) : (
              <button className="quiet" disabled={busy} onClick={() => setArming(true)}>
                빼기
              </button>
            ))}
          <span className="right" />
          <button className="quiet" onClick={onClose}>
            취소
          </button>
          <button className="primary" disabled={busy} onClick={save}>
            저장
          </button>
        </footer>
      </div>
    </>
  );
}

const hasRef = (v: string) => /\$\{(env|file):[^}]+\}/.test(v);

/** Skills and hooks stay read-only here; MCP servers are the priority. */
function SkillsHooks({ source }: { source: SourceView }) {
  const skills = Object.entries(source.skills).sort(([a], [b]) => a.localeCompare(b));
  const hooks = Object.entries(source.hooks).sort(([a], [b]) => a.localeCompare(b));
  if (skills.length === 0 && hooks.length === 0) return null;
  return (
    <>
      {skills.length > 0 && (
        <details className="fold">
          <summary>스킬 {skills.length}개 · 읽기 전용</summary>
          <ul className="rows">
            {skills.map(([n, k]) => (
              <li key={n} className="part-row">
                <span className="row-main">
                  <span className="row-title">{n}</span>
                </span>
                <span className="chips">
                  {sharedList(k.share).map((h) => (
                    <span key={h} className="chip">
                      {short(h)}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {hooks.length > 0 && (
        <details className="fold">
          <summary>후크 {hooks.length}개 · 읽기 전용</summary>
          <ul className="rows">
            {hooks.map(([n, k]) => (
              <li key={n} className="part-row">
                <span className="row-main">
                  <span className="row-title">{n}</span>
                  <span className="row-sub">{k.event}</span>
                </span>
                <span className="chips">
                  {sharedList(k.share).map((h) => (
                    <span key={h} className="chip">
                      {short(h)}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** The plan diff per harness, then 적용 through the approval gate. */
function DiffSheet({ plan, busy, onClose, onApply }: { plan: PlanView; busy: boolean; onClose: () => void; onApply: () => void }) {
  const panel = useFocusTrap(onClose);
  const perHarness = HARNESS_IDS.map((h) => ({ h, targets: plan.targets.filter((t) => t.harness === h && (t.error || size(t.diff) > 0)) })).filter((g) => g.targets.length > 0);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="diff-title" ref={panel}>
        <header className="drawer-head">
          <div>
            <h2 className="drawer-title" id="diff-title">
              바뀔 내용
            </h2>
            <div className="drawer-sub">값은 가려져 있어요 · 승인해야 적용돼요</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>
        <div className="drawer-body">
          {perHarness.length === 0 && <p className="muted">바뀔 게 없어요.</p>}
          {perHarness.map(({ h, targets }) => (
            <Section key={h} label={toolName(h)}>
              {targets.map((t) => (
                <div key={t.target} className="diff-target">
                  {!(sectionOf(t.target) === "외부 도구" && !t.target.endsWith(":project")) && (
                    <p className="muted">
                      {sectionOf(t.target)}
                      {t.target.endsWith(":project") ? " · 프로젝트" : ""}
                    </p>
                  )}
                  {t.error ? (
                    <div className="card error">⚠️ {t.error}</div>
                  ) : (
                    <ul className="rows">
                      {t.diff.added.map((a) => (
                        <li key={`a${a.name}`} className="part-row">
                          <span className="row-main">
                            <span className="row-title">{a.name}</span>
                            <span className="row-sub">추가{keys(a.after).length > 0 && ` · ${keys(a.after).join(", ")}`}</span>
                          </span>
                        </li>
                      ))}
                      {t.diff.changed.map((c) => (
                        <li key={`c${c.name}`} className="part-row">
                          <span className="row-main">
                            <span className="row-title">{c.name}</span>
                            <span className="row-sub">변경 · {c.fields.map((f) => f.field).join(", ")}</span>
                          </span>
                        </li>
                      ))}
                      {t.diff.removed.map((r) => (
                        <li key={`r${r.name}`} className="part-row">
                          <span className="row-main">
                            <span className="row-title">{r.name}</span>
                            <span className="row-sub">삭제</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </Section>
          ))}
        </div>
        <footer className="drawer-foot">
          <button className="quiet" onClick={onClose}>
            닫기
          </button>
          <button className="primary" disabled={busy || !plan.ok} onClick={onApply}>
            적용
          </button>
        </footer>
      </div>
    </>
  );
}

const size = (d: DiffView) => d.added.length + d.changed.length + d.removed.length;
const keys = (o: Record<string, unknown>) => Object.keys(o);

// ---------------------------------------------------------------------------
// Shot fakes: canned data, no backend calls. Reached at #/settings/harness?fake=….
// ---------------------------------------------------------------------------

const FAKE_SOURCE: SourceView = {
  mcpServers: {
    notion: { type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer ${env:NOTION_TOKEN}" }, share: "all" },
    pencil: { type: "stdio", command: "pencil", args: ["--stdio"], env: { API_KEY: "<set>" }, share: ["claude-code", "codex"] },
    figma: { type: "stdio", command: "figma-mcp", share: ["opencode"] },
  },
  instructions: {},
  skills: { review: { dir: "skills/review", share: "all" } },
  hooks: { bell: { event: "Stop", command: "printf '\\a'", share: ["claude-code"] } },
};

const FAKE_FILES: FileEntry[] = HARNESS_IDS.map((h) => ({ target: `${h}:user`, path: `/fake/${h}`, exists: true, managed: ["notion", "pencil"], unmanaged: ["mine"] }));

const FAKE_PLAN: PlanView = {
  planId: "fake",
  ok: true,
  changes: 3,
  targets: [
    { target: "claude-code:user", harness: "claude-code", diff: { added: [{ name: "notion", after: { type: "http", url: "https://mcp.notion.com/mcp" } }], changed: [], removed: [] } },
    { target: "codex:user", harness: "codex", diff: { added: [], changed: [{ name: "pencil", fields: [{ field: "command" }, { field: "env.API_KEY" }] }], removed: [] } },
    { target: "opencode:user", harness: "opencode", diff: { added: [], changed: [], removed: [{ name: "pencil" }] } },
  ],
};

const FAKE_DRY: ImportDry = {
  conflicts: { pencil: { targets: ["claude-code:user", "codex:user"], fields: ["command", "env.API_KEY"] } },
  counts: { "claude-code:user": { entries: 2 }, "codex:user": { entries: 2 }, "opencode:user": { entries: 1 }, "gjc:user": { entries: 1 } },
};

function FakeHarness({ kind }: { kind: string }) {
  const noop = () => {};
  if (kind === "diff")
    return (
      <div className="page">
        <Header title="실행 도구 설정" back="#/settings" />
        <div className="pane-scroll page-body">
          <HarnessCards files={FAKE_FILES} />
          <McpList source={FAKE_SOURCE} busy={false} onToggle={noop} onEdit={noop} onAdd={noop} />
          <SkillsHooks source={FAKE_SOURCE} />
        </div>
        <DiffSheet plan={FAKE_PLAN} busy={false} onClose={noop} onApply={noop} />
      </div>
    );
  if (kind === "list")
    return (
      <div className="page">
        <Header title="실행 도구 설정" back="#/settings" />
        <div className="pane-scroll page-body">
          <HarnessCards files={FAKE_FILES} />
          <McpList source={FAKE_SOURCE} busy={false} onToggle={noop} onEdit={noop} onAdd={noop} />
          <SkillsHooks source={FAKE_SOURCE} />
        </div>
        <div className="apply-bar">
          <span>3개 바뀜</span>
          <button className="primary">미리보기</button>
        </div>
      </div>
    );
  return (
    <div className="page">
      <Header title="실행 도구 설정" back="#/settings" />
      <div className="pane-scroll page-body">
        <ImportCard dry={FAKE_DRY} resolutions={{ pencil: "claude-code:user" }} busy={false} onPick={noop} onLoad={noop} onSkip={noop} onAdopt={noop} />
        <HarnessCards files={HARNESS_IDS.map((h) => ({ target: `${h}:user`, path: `/fake/${h}`, exists: h === "claude-code", managed: [], unmanaged: [] }))} />
        <p className="muted pad">
          <a className="link" href={harnessHref("list")}>
            목록 미리보기 ›
          </a>
        </p>
      </div>
    </div>
  );
}

export function HarnessLink() {
  return (
    <Section label="실행 도구">
      <ul className="rows boxed">
        <li>
          <a className="row-link" href={harnessHref()}>
            <span className="row-main">
              <span className="row-title">실행 도구 설정</span>
              <span className="row-sub">외부 도구가 어느 앱에 가는지 정해요</span>
            </span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </a>
        </li>
      </ul>
    </Section>
  );
}
