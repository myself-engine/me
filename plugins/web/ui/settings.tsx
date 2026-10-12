// 설정: one modal (full screen on phones) with sections 일반 / 모델 / 실행 도구 /
// 프로젝트 / 기기 점검. Reuses the existing components; no logic is deleted.
import { useEffect, useState } from "react";
import type { HeadChoice } from "./state.ts";
import { DefaultAccess } from "./access.tsx";
import { useDevView } from "./dev.ts";
import { HarnessScreen } from "./harness.tsx";
import { HeadChip } from "./head.tsx";
import { ProjectsSection } from "./projects.tsx";
import { DeviceSection } from "./ops.tsx";
import { useFocusTrap } from "./shared.tsx";

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
          <span className="muted"> · 타임라인, raw diff, 실행 도구·모델 표시를 켜요</span>
        </span>
      </label>
      <div>
        <p className="section-label">기본 접근 모드</p>
        <DefaultAccess />
        <p className="pick-note muted">새 대화가 이 모드로 시작해요. 전부 알아서는 확인 후 바로 커밋돼요.</p>
      </div>
    </div>
  );
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
