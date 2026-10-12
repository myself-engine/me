// Access mode control: 읽기만 / 프로젝트 쓰기 / 전부 알아서.
// Contract (backend lands separately): gjc-head.settings default field `access`
// and per-thread field `access`; head.thread.set / head.defaults.set accept
// `access` (full requires `confirm: true`); chat.send accepts `access` for a new
// thread. Until the backend lands, failures surface as a toast and the UI keeps
// the previous value.
import { useState } from "react";
import type { Access, Thread } from "./api.ts";
import { useApp } from "./context.ts";
import { useBusy, useFocusTrap } from "./shared.tsx";
import { accessOf, type HeadChoice } from "./state.ts";

export const ACCESS_LABEL: Record<Access, string> = {
  read: "읽기만",
  project: "프로젝트 쓰기",
  full: "전부 알아서",
};

/** Always-visible one line under the segment: what the picked mode does. */
export const ACCESS_DESC: Record<Access, string> = {
  read: "질문에만 답해요 · 파일은 바꾸지 않아요",
  project: "선택한 프로젝트에서 바로 작업해요 · 결과는 확인 후 반영해요",
  full: "작업을 끝내면 확인 없이 바로 커밋해요",
};

const ORDER: Access[] = ["read", "project", "full"];

/** Segmented control next to the input. For a new thread the pick rides on the draft; for an open thread it is saved at once. */
export function AccessControl({ thread, draft, setDraft }: { thread: Thread | null; draft: HeadChoice; setDraft: (c: HeadChoice) => void }) {
  const { s, conn, notify } = useApp();
  const [busy, act] = useBusy(notify);
  const [confirming, setConfirming] = useState(false);
  const cur = accessOf(thread ?? draft, s.headSettings);

  const save = (access: Access, confirm: boolean) =>
    act(async () => {
      if (!conn) return;
      if (!thread) {
        setDraft({ ...draft, access: access === accessOf(null, s.headSettings) ? null : access });
        // New threads take the default; choosing here also moves the default so the next draft matches.
        await conn.request("head.defaults.set", { access, ...(access === "full" ? { confirm } : {}) }).catch((err: Error) => {
          notify(err.message);
          throw err;
        });
        return;
      }
      await conn.request("head.thread.set", { threadId: thread.id, access, ...(access === "full" ? { confirm } : {}) });
    });

  const pick = (access: Access) => {
    if (access === cur) return;
    if (access === "full") setConfirming(true);
    else void save(access, false);
  };

  return (
    <>
      <div className="access-block">
        <div className="access" role="group" aria-label="접근 모드" aria-describedby="access-desc">
          {ORDER.map((a) => (
            <button
              key={a}
              type="button"
              className={`access-btn${a === cur ? " on" : ""}`}
              aria-pressed={a === cur}
              disabled={busy || !conn}
              onClick={() => pick(a)}
            >
              {ACCESS_LABEL[a]}
            </button>
          ))}
        </div>
        <p className="access-desc" id="access-desc">
          {ACCESS_DESC[cur]}
        </p>
      </div>
      {confirming && <FullConfirm busy={busy} onCancel={() => setConfirming(false)} onOk={() => (setConfirming(false), save("full", true))} />}
    </>
  );
}

/** Choosing 전부 알아서 asks for confirmation with a checkbox before sending confirm:true. */
function FullConfirm({ busy, onCancel, onOk }: { busy: boolean; onCancel: () => void; onOk: () => void }) {
  const [checked, setChecked] = useState(false);
  const panel = useFocusTrap(onCancel);
  return (
    <>
      <div className="scrim" onClick={onCancel} />
      <div className="drawer confirm-sheet" role="dialog" aria-modal="true" aria-labelledby="full-title" ref={panel}>
        <h2 className="drawer-title" id="full-title">
          전부 알아서로 바꿀까요?
        </h2>
        <p className="muted">맡긴 작업이 끝나면 결과를 확인하지 않고 바로 커밋돼요.</p>
        <label className="confirm-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          결과를 확인하지 않고 바로 커밋되는 걸 이해했어요
        </label>
        <div className="actions-row">
          <button type="button" className="quiet" onClick={onCancel}>
            취소
          </button>
          <button type="button" className="primary" disabled={busy || !checked} onClick={onOk}>
            바꾸기
          </button>
        </div>
      </div>
    </>
  );
}

/** Settings › 일반: the default access mode for new threads. */
export function DefaultAccess() {
  const { s, conn, notify } = useApp();
  const [busy, act] = useBusy(notify);
  const cur = accessOf(null, s.headSettings);
  return (
    <div className="access-block">
      <div className="access" role="group" aria-label="기본 접근 모드" aria-describedby="default-access-desc">
        {ORDER.map((a) => (
          <button
            key={a}
            type="button"
            className={`access-btn${a === cur ? " on" : ""}`}
            aria-pressed={a === cur}
            disabled={busy || !conn}
            onClick={() => act(() => conn!.request("head.defaults.set", { access: a, ...(a === "full" ? { confirm: true } : {}) }).catch((err: Error) => notify(err.message)))}
          >
            {ACCESS_LABEL[a]}
          </button>
        ))}
      </div>
      <p className="access-desc" id="default-access-desc">
        {ACCESS_DESC[cur]}
      </p>
    </div>
  );
}
