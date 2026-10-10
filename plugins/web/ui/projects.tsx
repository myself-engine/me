// 프로젝트: configured repositories plus every project a task ran in, with task counts by status.
import { useMemo } from "react";
import { useApp } from "./context.ts";
import { taskHref } from "./routes.ts";
import { Empty, Header, StatusDot, repoName, shortPath } from "./shared.tsx";
import { TONE_LABEL, toneOf, workItems, type Tone } from "./state.ts";

const SHOWN: Tone[] = ["needs", "running", "done", "failed"];

export function ProjectsScreen() {
  const { s } = useApp();
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
    <div className="page">
      <Header title="프로젝트" />
      <div className="pane-scroll page-body">
        {repos.length === 0 ? (
          <Empty title="등록된 저장소가 없어요">웹 플러그인 설정의 projects에 저장소를 넣거나 작업을 위임하면 여기에 생겨요.</Empty>
        ) : (
          <ul className="rows boxed">
            {repos.map((r) => (
              <li key={r.path}>
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
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
