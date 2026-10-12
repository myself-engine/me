// ProjectPicker: one sheet for picking a repository without typing paths.
// Used by the composer and by 상태 › 프로젝트. Selecting an unregistered
// repository registers it (projects.add) before handing it back.
import { useEffect, useMemo, useState } from "react";
import { useApp } from "./context.ts";
import { repoName, shortPath, useBusy, useFocusTrap } from "./shared.tsx";

export interface Discovered {
  path: string;
  name: string;
  registered: boolean;
}

interface Match {
  path: string;
  name: string;
  isRepo: boolean;
}

const matches = (path: string, name: string, q: string) => {
  const query = q.trim().toLowerCase();
  return !query || name.toLowerCase().includes(query) || path.toLowerCase().includes(query);
};

/** The composer's project control: a button that opens the sheet, never a bare select. */
export function ProjectButton({ project, projects, setProject }: { project: string; projects: string[]; setProject: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="project-button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={project ? `프로젝트: ${repoName(project)} (바꾸기)` : "프로젝트 고르기"}>
        <span aria-hidden="true">{project ? `📁 ${repoName(project)}` : "📁 프로젝트 고르기"}</span>
        <span className="chip-chev" aria-hidden="true">
          {" ▾"}
        </span>
      </button>
      {open && <ProjectPicker current={project} recent={projects} onPick={setProject} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ProjectPicker({ current, recent, onPick, onClose }: { current: string; recent: string[]; onPick: (p: string) => void; onClose: () => void }) {
  const { conn, notify } = useApp();
  const panel = useFocusTrap(onClose);
  const [query, setQuery] = useState("");
  const [discovered, setDiscovered] = useState<Discovered[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, act] = useBusy(notify);

  useEffect(() => {
    if (!conn) return;
    let alive = true;
    conn
      .request<{ projects: Discovered[] }>("projects.discover")
      .then((r) => alive && setDiscovered(r.projects))
      .catch((err: Error) => alive && setFailed(err.message));
    return () => {
      alive = false;
    };
  }, [conn]);

  const pick = (path: string, registered: boolean) =>
    act(async () => {
      if (!conn) return;
      if (!registered) {
        await conn.request("projects.add", { path });
        notify("프로젝트를 추가했어요");
      }
      onPick(path);
      onClose();
    });

  const shownRecent = useMemo(() => [...new Set(recent.filter(Boolean))].filter((p) => matches(p, repoName(p), query)), [recent.join("|"), query]);
  const shownFound = useMemo(
    () => (discovered ?? []).filter((d) => !shownRecent.includes(d.path) && matches(d.path, d.name, query)),
    [discovered, shownRecent.join("|"), query],
  );

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer project-sheet" role="dialog" aria-modal="true" aria-labelledby="project-title" ref={panel}>
        <header className="drawer-head">
          <div>
            <h2 className="drawer-title" id="project-title">
              프로젝트 고르기
            </h2>
            <div className="drawer-sub">한 번 누르면 바로 골라져요</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>
        <div className="drawer-body stack">
          <input
            type="search"
            className="pick-search"
            placeholder="이름이나 경로로 찾기"
            aria-label="프로젝트 찾기"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <section aria-label="최근">
            <p className="section-label">최근</p>
            {shownRecent.length === 0 ? (
              <p className="muted">아직 고른 프로젝트가 없어요.</p>
            ) : (
              <ul className="pick-list">
                {shownRecent.map((p) => (
                  <li key={p}>
                    <button type="button" className={`pick-row project-pick-row${p === current ? " on" : ""}`} disabled={busy || !conn} onClick={() => pick(p, true)}>
                      <span className="pick-label">
                        <span className="pick-name">📁 {repoName(p)}</span>
                        <span className="pick-sub muted" title={p}>
                          {shortPath(p)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="이 Mac의 저장소">
            <p className="section-label">이 Mac의 저장소</p>
            {!discovered && !failed && <p className="muted">저장소를 찾는 중…</p>}
            {failed && <p className="muted">저장소를 못 찾았어요: {failed}</p>}
            {discovered && shownFound.length === 0 && <p className="muted">{query ? `"${query}"에 맞는 저장소가 없어요.` : "찾은 저장소가 없어요. 아래에서 폴더를 직접 넣어 주세요."}</p>}
            {shownFound.length > 0 && (
              <ul className="pick-list">
                {shownFound.map((d) => (
                  <li key={d.path}>
                    <button type="button" className="pick-row project-pick-row" disabled={busy || !conn} onClick={() => pick(d.path, d.registered)}>
                      <span className="pick-label">
                        <span className="pick-name">📁 {d.name}</span>
                        <span className="pick-sub muted" title={d.path}>
                          {shortPath(d.path)}
                          {d.registered ? " · 추가됨" : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <ManualFolder onPick={pick} busy={busy} />
        </div>
      </div>
    </>
  );
}

/** The bottom fold: a path typed with visible completion suggestions, never blind. */
function ManualFolder({ onPick, busy }: { onPick: (path: string, registered: boolean) => void; busy: boolean }) {
  const { conn, notify } = useApp();
  const [path, setPath] = useState("");
  const [suggestions, setSuggestions] = useState<Match[] | null>(null);
  const [, act] = useBusy(notify);

  useEffect(() => {
    if (!conn || !path.trim()) {
      setSuggestions(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      conn
        .request<{ matches: Match[] }>("projects.complete", { path })
        .then((r) => alive && setSuggestions(r.matches))
        .catch(() => alive && setSuggestions([]));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [conn, path]);

  const submit = () =>
    act(async () => {
      if (!conn || !path.trim()) return;
      const r = await conn.request<{ path: string }>("projects.add", { path });
      notify("프로젝트를 추가했어요");
      onPick(r.path, true);
    });

  return (
    <details className="fold">
      <summary>다른 폴더…</summary>
      <form
        className="field-row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="sr" htmlFor="proj-manual">
          저장소 경로
        </label>
        <input
          id="proj-manual"
          className="field-input"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/dev/저장소"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" disabled={busy || !conn || !path.trim()}>
          추가
        </button>
      </form>
      {suggestions && suggestions.length > 0 && (
        <ul className="pick-list manual-suggest">
          {suggestions.map((m) => (
            <li key={m.path}>
              <button type="button" className="pick-row project-pick-row" disabled={busy || !conn} onClick={() => (m.isRepo ? onPick(m.path, false) : setPath(`${m.path}/`))}>
                <span className="pick-label">
                  <span className="pick-name">{m.isRepo ? `📁 ${m.name}` : m.name}</span>
                  <span className="pick-sub muted" title={m.path}>
                    {shortPath(m.path)}
                    {m.isRepo ? "" : " · 폴더 열기"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {suggestions && path.trim() && suggestions.length === 0 && <p className="muted">일치하는 하위 폴더가 없어요.</p>}
    </details>
  );
}
