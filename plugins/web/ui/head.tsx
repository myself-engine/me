// The head's model and effort: a chip above the composer and the sheet it opens.
// Picking a model applies to this conversation; an unchecked-by-default checkbox
// also saves it as the default for new conversations.
import { useEffect, useMemo, useState } from "react";
import type { Connection, Effort, ModelInfo, Thread } from "./api.ts";
import { useApp } from "./context.ts";
import { useDevView } from "./dev.ts";
import { useBusy, useFocusTrap } from "./shared.tsx";
import { headChoice, shortModel, type HeadChoice } from "./state.ts";

const EFFORT_LABEL: Record<Effort, string> = {
  off: "생각 안 함",
  minimal: "최소",
  low: "낮음",
  medium: "보통",
  high: "높음",
  xhigh: "매우 높음",
  max: "최대",
};
export const effortLabel = (e: string) => EFFORT_LABEL[e as Effort] ?? e;

/** `gjc --list-models` takes seconds; one request per page load is enough. */
let catalog: Promise<ModelInfo[]> | null = null;
const loadCatalog = (conn: Connection) => (catalog ??= conn.request<ModelInfo[]>("head.models").catch((err) => ((catalog = null), Promise.reject(err))));

/** Shows what the next reply will use; opens the picker. `thread` is null for a new thread, whose choice is the draft. */
export function HeadChip({ thread, draft, setDraft }: { thread: Thread | null; draft: HeadChoice; setDraft: (c: HeadChoice) => void }) {
  const { s } = useApp();
  const [open, setOpen] = useState(false);
  const cur = headChoice(thread ?? draft, s.headSettings);
  if (!cur) return null;
  return (
    <>
      {cur.isDefault ? (
        <button
          className="head-chip default"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-label={`모델: ${cur.model}, ${effortLabel(cur.effort)} (기본값)`}
        >
          <span aria-hidden="true">⚙ 모델</span>
          <span className="chip-chev" aria-hidden="true">
            ▾
          </span>
        </button>
      ) : (
        <button className="head-chip" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label="모델 바꾸기">
          <span className="sr">모델: </span>
          <span aria-hidden="true">⚙ </span>
          {shortModel(cur.model)} · {effortLabel(cur.effort)}
          <span className="chip-chev" aria-hidden="true">
            ▾
          </span>
        </button>
      )}
      {open && <HeadSheet thread={thread} draft={draft} setDraft={setDraft} onClose={() => setOpen(false)} />}
    </>
  );
}

function HeadSheet({ thread, draft, setDraft, onClose }: { thread: Thread | null; draft: HeadChoice; setDraft: (c: HeadChoice) => void; onClose: () => void }) {
  const { s, conn, notify } = useApp();
  const [dev] = useDevView();
  const d = s.headSettings!;
  const cur = headChoice(thread ?? draft, d)!;
  const [model, setModel] = useState(cur.model);
  const [effort, setEffort] = useState<Effort>(cur.effort);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, act] = useBusy(notify);
  const panel = useFocusTrap(onClose);

  useEffect(() => {
    if (!conn) return;
    let alive = true;
    loadCatalog(conn)
      .then((m) => alive && setModels(m))
      .catch((err) => alive && setListError(err.message));
    return () => {
      alive = false;
    };
  }, [conn]);

  const info = models?.find((m) => m.id === model);
  const efforts = info?.efforts ?? d.efforts;
  // A model that cannot think at the picked level falls back to its nearest offered level.
  useEffect(() => {
    if (!efforts.includes(effort)) setEffort(efforts.includes("off") ? "off" : efforts[0]!);
  }, [model, efforts.join(",")]);

  const shown = useMemo(() => {
    const top = [...new Set([model, d.model, ...d.favorites])];
    const q = query.trim().toLowerCase();
    if (!q) return top.map((id) => ({ id, favorite: true }));
    const found = (models ?? []).filter((m) => m.id.toLowerCase().includes(q)).slice(0, 40);
    return found.map((m) => ({ id: m.id, favorite: top.includes(m.id) }));
  }, [model, d.model, d.favorites.join(","), query, models]);

  // This conversation keeps the pick; the checkbox below also saves it as the default.
  const [alsoDefault, setAlsoDefault] = useState(false);
  const choose = () =>
    act(async () => {
      if (!conn) return;
      if (!thread) {
        setDraft({ ...draft, model, effort });
      } else {
        await conn.request("head.thread.set", { threadId: thread.id, model, effort });
      }
      if (alsoDefault) {
        await conn.request("head.defaults.set", { model, effort });
        notify("새 대화의 기본 모델로 저장했어요");
      }
      onClose();
    });
  const favSet = useMemo(() => new Set(d.favorites), [d.favorites.join(",")]);
  const configFavSet = useMemo(() => new Set(d.configFavorites ?? []), [(d.configFavorites ?? []).join(",")]);
  const toggleFav = (id: string, on: boolean) =>
    act(async () => {
      await conn!.request("head.favorites.set", { model: id, on });
    });

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer head-sheet" role="dialog" aria-modal="true" aria-labelledby="head-title" ref={panel}>
        <header className="drawer-head">
          <div>
            <h2 className="drawer-title" id="head-title">
              모델 고르기
            </h2>
            <div className="drawer-sub">{thread ? "이 대화에만 적용돼요" : "새로 시작할 이 대화에 적용돼요"}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>
        <div className="drawer-body stack">
          {dev && (
            <fieldset className="pick">
              <legend>생각 정도 (effort)</legend>
              <div className="seg">
                {efforts.map((e) => (
                  <label key={e} className={`seg-item${e === effort ? " on" : ""}`}>
                    <input type="radio" name="effort" value={e} checked={e === effort} onChange={() => setEffort(e)} />
                    {effortLabel(e)}
                  </label>
                ))}
              </div>
              <p className="pick-note muted">높을수록 답이 깊어지지만 느려져요. 짧은 대화는 "생각 안 함"이 빨라요.</p>
            </fieldset>
          )}
          <fieldset className="pick">
            <legend>모델</legend>
            <input type="search" className="pick-search" placeholder="모델 검색 (예: sol, kimi, gemini)" aria-label="모델 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
            {query && !models && !listError && <p className="muted">모델 목록을 불러오는 중…</p>}
            {listError && <p className="muted">모델 목록을 못 불러왔어요: {listError}</p>}
            {query && models && shown.length === 0 && <p className="muted">"{query}"에 맞는 모델이 없어요.</p>}
            <ul className="pick-list">
              {shown.map((m) => {
                const fav = favSet.has(m.id);
                const locked = fav && configFavSet.has(m.id);
                return (
                  <li key={m.id} className={`pick-row${m.id === model ? " on" : ""}`}>
                    <label className="pick-label">
                      <input type="radio" name="model" value={m.id} checked={m.id === model} onChange={() => setModel(m.id)} />
                      <span className="pick-name">{shortModel(m.id)}</span>
                      <span className="pick-sub muted">
                        {m.id.slice(0, m.id.lastIndexOf("/"))}
                        {m.id === d.model ? " · 기본값" : ""}
                      </span>
                    </label>
                    {dev && (
                      <button
                        type="button"
                        className={`fav${fav ? " on" : ""}`}
                        aria-pressed={fav}
                        aria-label={locked ? `설정 파일 즐겨찾기라 뺄 수 없어요: ${m.id}` : fav ? `즐겨찾기에서 빼기: ${m.id}` : `즐겨찾기에 넣기: ${m.id}`}
                        title={locked ? "설정 파일에 적힌 즐겨찾기라 여기서 뺄 수 없어요" : undefined}
                        disabled={busy || !conn || locked}
                        onClick={() => toggleFav(m.id, !fav)}
                      >
                        <span aria-hidden="true">{fav ? "★" : "☆"}</span>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {dev && <p className="pick-note muted">★로 자주 쓰는 모델을 즐겨찾기에 고정해요. 설정 파일에 적힌 즐겨찾기는 여기서 뺄 수 없어요. Claude 모델은 대화 엔진에서 쓸 수 없어 목록에 없어요.</p>}
          </fieldset>
        </div>
        <footer className="drawer-foot">
          <label className="check-row">
            <input type="checkbox" checked={alsoDefault} onChange={(e) => setAlsoDefault(e.target.checked)} />
            <span>새 대화에도 이 모델 쓰기</span>
          </label>
          <div className="actions-row">
            <button className="primary" disabled={busy || !conn} onClick={choose}>
              선택
            </button>
            <button className="quiet" onClick={onClose}>
              취소
            </button>
          </div>
        </footer>
      </div>
    </>
  );
}
