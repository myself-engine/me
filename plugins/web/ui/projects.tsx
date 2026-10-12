// 상태 › 프로젝트: configured repositories plus every project a task ran in, with task counts by status.
// Extra repositories are added here without editing files: stored as the web-owned
// web.settings entity, validated server-side (must exist and be a git repo).
import { useMemo, useState } from "react";
import { useApp } from "./context.ts";
import { taskHref } from "./routes.ts";
import { Section, StatusDot, repoName, shortPath, useBusy } from "./shared.tsx";
import { TONE_LABEL, toneOf, workItems, type Tone } from "./state.ts";

const SHOWN: Tone[] = ["needs", "running", "done", "failed"];

export function ProjectsSection() {
  const { s } = useApp();
  const added = useMemo(() => new Set(s.config.addedProjects ?? []), [s.config.addedProjects]);
  const repos = useMemo(() => {
    const items = workItems(s);
    const paths = [...new Set([...s.config.projects, ...items.map((w) => w.project)].filter(Boolean))];
    return paths
      .map((path) => {
        const counts: Partial<Record<Tone, number>> = {};
        for (const w of items) if (w.project === path) counts[toneOf(w.state)] = (counts[toneOf(w.state)] ?? 0) + 1;
        return { path, counts, total: items.filter((w) => w.project === path).length };
      })
      .sort((a, b) => (b.counts.needs ?? 0) - (a.counts.needs ?? 0) || b.total - a.total || repoName(a.path).localeCompare(repoName(b.path)));
  }, [s.config.projects, s.tasks, s.approvals, s.messages]);

  return (
    <Section label="프로젝트" count={repos.length || undefined}>
      <ProjectForm />
      {repos.length === 0 ? (
        <p className="muted pad">등록된 저장소가 없어요. 아래에 경로를 넣거나 작업을 맡기면 생겨요.</p>
      ) : (
        <ul className="rows boxed">
          {repos.map((r) => (
            <li key={r.path} className={added.has(r.path) ? "proj-row" : undefined}>
              <a className="row-link" href={taskHref(null, r.path)}>
                <span className="row-main">
                  <span className="row-title">{repoName(r.path)}</span>
                  <span className="row-sub" title={r.path}>
                    {shortPath(r.path)}
                  </span>
                  <span className="counts">
                    {r.total === 0 ? (
                      <span className="muted">작업 없음</span>
                    ) : (
                      SHOWN.filter((t) => r.counts[t]).map((t) => (
                        <span key={t} className="count-item">
                          <StatusDot tone={t} label={`${TONE_LABEL[t]} ${r.counts[t]}`} />
                        </span>
                      ))
                    )}
                  </span>
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </a>
              {added.has(r.path) && <ProjectRemove path={r.path} />}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Adds a repository path: the server checks it exists and is a git repo. */
function ProjectForm() {
  const { conn, notify } = useApp();
  const [path, setPath] = useState("");
  const [busy, act] = useBusy(notify);
  const submit = () =>
    act(async () => {
      if (!conn) return;
      await conn.request("projects.add", { path });
      setPath("");
      notify("프로젝트를 추가했어요");
    });
  return (
    <form
      className="field-row proj-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="sr" htmlFor="proj-add">
        저장소 경로
      </label>
      <input
        id="proj-add"
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
  );
}

/** Removes a repository added here; config-file projects have no button. */
function ProjectRemove({ path }: { path: string }) {
  const { conn, notify } = useApp();
  const [busy, act] = useBusy(notify);
  return (
    <button type="button" className="quiet proj-remove" aria-label={`${repoName(path)} 삭제`} disabled={busy || !conn} onClick={() => act(() => conn!.request("projects.remove", { path }))}>
      삭제
    </button>
  );
}
