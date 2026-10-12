// 설정: one modal (full screen on phones) with sections 일반 / 모델 / 실행 도구 /
// 프로젝트 / 기기 점검. Reuses the existing components; no logic is deleted.
import { useEffect, useState } from "react";
import { useApp } from "./context.ts";
import { pushSupport, urlBase64ToUint8Array } from "./push.ts";
import type { HeadChoice } from "./state.ts";
import { DefaultAccess } from "./access.tsx";
import { useDevView } from "./dev.ts";
import { HarnessScreen } from "./harness.tsx";
import { HeadChip } from "./head.tsx";
import { ProjectsSection } from "./projects.tsx";
import { DeviceSection } from "./ops.tsx";
import { useBusy, useFocusTrap } from "./shared.tsx";

const SECTIONS = [
  { id: "general", label: "일반" },
  { id: "model", label: "모델" },
  { id: "harness", label: "실행 도구" },
  { id: "projects", label: "프로젝트" },
  { id: "device", label: "기기 점검" },
] as const;

export function SettingsModal({ section, fake, onClose }: { section: string | null; fake: string | null; onClose: () => void }) {
  // Harness shot fakes keep their standalone page layout.
  if (section === "harness" && fake) return <HarnessScreen fake={fake} />;
  return <Modal section={section} fake={fake} onClose={onClose} />;
}

function Modal({ section, fake, onClose }: { section: string | null; fake: string | null; onClose: () => void }) {
  const panel = useFocusTrap(onClose);
  const [tab, setTab] = useState<string>(section ?? "general");
  useEffect(() => {
    if (section) setTab(section);
  }, [section]);
  useEffect(() => {
    document.getElementById(`settings-${tab}`)?.scrollIntoView({ block: "start" });
  }, [tab]);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={panel}>
        <header className="drawer-head">
          <div>
            <h2 className="drawer-title" id="settings-title">
              설정
            </h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>
        <nav className="settings-nav" aria-label="설정 분류">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={`settings-tab${tab === s.id ? " on" : ""}`} aria-current={tab === s.id ? "true" : undefined} onClick={() => setTab(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="drawer-body" tabIndex={0} aria-label="설정 내용">
          <section id="settings-general" aria-label="일반">
            <h3 className="section-label">일반</h3>
            <GeneralSection />
          </section>
          <section id="settings-model" aria-label="모델">
            <h3 className="section-label">모델</h3>
            <ModelSection />
          </section>
          <section id="settings-harness" aria-label="실행 도구">
            <h3 className="section-label">실행 도구</h3>
            <HarnessSection fake={fake} />
          </section>
          <section id="settings-projects" aria-label="프로젝트">
            <ProjectsSection />
          </section>
          <section id="settings-device" aria-label="기기 점검">
            <h3 className="section-label">기기 점검</h3>
            <DeviceSection />
          </section>
        </div>
      </div>
    </>
  );
}

function GeneralSection() {
  const [dev, setDev] = useDevView();
  return (
    <div className="stack">
      <label className="check-row">
        <input type="checkbox" checked={dev} onChange={(e) => setDev(e.target.checked)} />
        <span>
          개발자 보기
          <span className="muted"> · 타임라인, 변경 내용 원문, 실행 도구·모델 표시를 켜요</span>
        </span>
      </label>
      <div>
        <p className="section-label">기본 접근 모드</p>
        <DefaultAccess />
        <p className="pick-note muted">새 대화가 이 모드로 시작해요. 전부 알아서는 확인 후 바로 적용돼요.</p>
      </div>
      <HarnessSelect />
      <PushRow />
      <BudgetLine />
    </div>
  );
}

/** Which headless harness answers: GJC (default) or OMP. One line; the model picker follows it. */
function HarnessSelect() {
  const { s, conn, notify } = useApp();
  const [busy, act] = useBusy(notify);
  const cur = s.headSettings?.harness ?? "gjc";
  return (
    <div>
      <label className="field">
        <span>대화 엔진 실행 도구</span>
        <select
          value={cur}
          disabled={busy || !conn}
          onChange={(e) => void act(async () => void (await conn!.request("head.defaults.set", { harness: e.target.value })))}
          aria-label="대화 엔진 실행 도구"
        >
          <option value="gjc">GJC</option>
          <option value="omp">OMP</option>
        </select>
      </label>
      <p className="pick-note muted">답을 쓰는 엔진을 바꿔요. GJC 로그인이 만료되면 OMP로 계속 대화할 수 있어요.</p>
    </div>
  );
}

/** Phone notifications: one row that subscribes this device, tests, or turns off. */
function PushRow() {
  const { conn } = useApp();
  const [support] = useState(() => pushSupport());
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (support !== "supported") return;
    let live = true;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (live) setSubscribed(sub !== null);
      })
      .catch(() => {
        if (live) setSubscribed(false);
      });
    return () => {
      live = false;
    };
  }, [support]);
  if (support === "unsupported") return <p className="muted">이 브라우저는 알림을 지원하지 않아요</p>;
  if (support === "insecure") return <p className="muted">알림은 https(예: tailscale serve) 또는 이 Mac의 localhost에서만 돼요</p>;
  if (subscribed === null) return <p className="muted">알림 상태를 확인하는 중…</p>;
  const fail = (err: unknown) => {
    setNote(err instanceof Error ? err.message : "실패했어요. 다시 해보세요");
    setBusy(false);
  };
  const endpointOf = async () => (await navigator.serviceWorker.ready).pushManager.getSubscription().then((s) => s?.endpoint ?? null);
  const turnOn = async () => {
    if (!conn) return;
    setBusy(true);
    setNote(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") {
        setNote("브라우저 설정에서 알림을 켜 주세요");
        setBusy(false);
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await conn.request<{ publicKey: string }>("push.publicKey", {});
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      const keys = sub.toJSON().keys!;
      await conn.request("push.subscribe", { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
      setSubscribed(true);
      setBusy(false);
    } catch (err) {
      fail(err);
    }
  };
  const turnOff = async () => {
    if (!conn) return;
    setBusy(true);
    setNote(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const endpoint = sub?.endpoint ?? (await endpointOf());
      if (sub) await sub.unsubscribe();
      if (endpoint) await conn.request("push.unsubscribe", { endpoint });
      setSubscribed(false);
      setBusy(false);
    } catch (err) {
      fail(err);
    }
  };
  const test = async () => {
    if (!conn) return;
    setBusy(true);
    setNote(null);
    try {
      const endpoint = await endpointOf();
      if (!endpoint) throw new Error("먼저 이 기기에서 알림 받기를 켜 주세요");
      await conn.request("push.test", { endpoint });
      setNote("시험 알림을 보냈어요");
      setBusy(false);
    } catch (err) {
      fail(err);
    }
  };
  return (
    <div>
      {subscribed ? (
        <div className="actions-row">
          <span>이 기기에서 받는 중</span>
          <button type="button" className="btn small" disabled={busy} onClick={test}>
            시험 알림
          </button>
          <button type="button" className="btn small" disabled={busy} onClick={turnOff}>
            끄기
          </button>
        </div>
      ) : (
        <button type="button" disabled={busy || !conn} onClick={turnOn}>
          이 기기에서 알림 받기
        </button>
      )}
      {note && <p className="muted">{note}</p>}
    </div>
  );
}

interface BudgetMeter {
  provider: string;
  bucket: string;
  remainingPercent: number;
}
interface BudgetStatus {
  delegations: number;
  dailyCap: number;
  autoApplied: number;
  autoApplyCap: number;
  meters: BudgetMeter[];
  problem: string | null;
}

/** Read-only one-liner: today's delegations and the tightest provider quota. Hidden when budget is missing. */
function BudgetLine() {
  const { conn } = useApp();
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!conn) return;
    let live = true;
    conn
      .request<BudgetStatus>("budget.status", {})
      .then((s) => {
        if (!live) return;
        setText(formatBudget(s));
      })
      .catch(() => {
        if (live) setText(null);
      });
    return () => {
      live = false;
    };
  }, [conn]);
  if (!text) return null;
  return <p className="muted">{text}</p>;
}

function formatBudget(s: BudgetStatus): string {
  const head = `오늘 위임 ${s.delegations}/${s.dailyCap}`;
  if (s.meters.length === 0) return s.problem ? `${head} · 한도를 확인하지 못했어요` : head;
  const tightest = s.meters.reduce((a, b) => (b.remainingPercent < a.remainingPercent ? b : a));
  return `${head} · ${tightest.provider} ${tightest.bucket} ${Math.floor(tightest.remainingPercent)}% 남음`;
}

function ModelSection() {
  const [draft, setDraft] = useState<HeadChoice>({});
  return (
    <div className="stack">
      <p className="muted">새 대화의 답에 쓸 모델이에요. 고르면 이 설정과 함께 저장돼요.</p>
      <div>
        <HeadChip thread={null} draft={draft} setDraft={setDraft} />
      </div>
    </div>
  );
}

function HarnessSection({ fake }: { fake: string | null }) {
  if (fake) return <HarnessScreen fake={fake} />;
  return <HarnessScreen fake={null} />;
}
