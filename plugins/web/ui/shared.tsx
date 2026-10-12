// Small pieces every screen uses: the status dot, markdown, headers, time and path formatting.
import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { fenceLanguage, highlight } from "./highlight.ts";
import { TONE_LABEL, type Tone } from "./state.ts";

const MD_COMPONENTS: Components = {
  code({ node: _node, className, children, ...rest }) {
    const lang = fenceLanguage(className);
    const html = typeof children === "string" ? highlight(children, lang) : null;
    if (html === null) return <code className={className} {...rest}>{children}</code>;
    return <code className={`${className} hljs`} {...rest} dangerouslySetInnerHTML={{ __html: html }} />;
  },
};

/** mdast node shape, just enough to repair literal bold runs without new deps. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/**
 * A closing ** directly followed by a letter (Korean routinely has no space
 * after, e.g. "**미( me )**입니다") is not a right-flanking run in CommonMark,
 * so the asterisks render literally. Repair those runs after parsing: turn the
 * leftover **…** into a strong node. Already-parsed emphasis, code spans and
 * lone ** (e.g. "2 ** 3") are untouched.
 */
export const remarkBoldGlued = () => (tree: MdNode) => {
  const walk = (node: MdNode): void => {
    if (!node.children) return;
    const out: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && typeof child.value === "string") {
        const re = /\*\*([^*]+?)\*\*(?=\p{L})/gu;
        let m: RegExpExecArray | null;
        let last = 0;
        const parts: MdNode[] = [];
        while ((m = re.exec(child.value)) !== null) {
          if (m.index > last) parts.push({ type: "text", value: child.value.slice(last, m.index) });
          parts.push({ type: "strong", children: [{ type: "text", value: m[1] }] });
          last = m.index + m[0].length;
        }
        if (parts.length === 0) {
          out.push(child);
          continue;
        }
        if (last < child.value.length) parts.push({ type: "text", value: child.value.slice(last) });
        out.push(...parts);
      } else {
        walk(child);
        out.push(child);
      }
    }
    node.children = out;
  };
  walk(tree);
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBoldGlued]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * One status mark for the whole UI: spinner = running, orange ? = needs you, green ✓ = done,
 * red dot = failed, grey dot = cancelled/rejected. Always paired with a short text label (touch has no hover).
 */
export function StatusDot({ tone, label, hideLabel = false }: { tone: Tone; label?: string; hideLabel?: boolean }) {
  const text = label ?? TONE_LABEL[tone];
  return (
    <span className={`status status-${tone}`}>
      <span className="sdot" aria-hidden="true">
        {tone === "needs" ? "?" : tone === "done" ? "✓" : ""}
      </span>
      {text && !hideLabel && <span className="slabel">{text}</span>}
      {text && hideLabel && <span className="sr">{text}</span>}
    </span>
  );
}

export const STATE_LABEL: Record<string, string> = {
  "awaiting-approval": "승인 대기",
  rejected: "거절됨",
  delegated: "맡김",
  running: "작업 중",
  sealed: "검토 대기",
  accepted: "적용 중",
  applied: "적용 완료",
  "apply-failed": "적용 실패",
  reverted: "되돌림 완료",
  failed: "실패",
  "awaiting-input": "입력 대기",
  cancelled: "취소됨",
  starting: "시작 중",
  stopped: "멈춤",
  quarantined: "격리됨",
};

export const stateLabel = (state: string) => STATE_LABEL[state] ?? state;
export const shortHarness = (h: string) => h.replace(/^local\./, "");
const TOOL_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", omp: "OMP", gjc: "GJC", opencode: "OpenCode" };
/** The tool's product name for people: local.claude-code → Claude Code. */
export const toolName = (h: string) => TOOL_NAMES[shortHarness(h)] ?? shortHarness(h);

export function Header({ title, back, children }: { title: ReactNode; back?: string; children?: ReactNode }) {
  return (
    <header className="bar">
      {back && (
        <a className="back" href={back} aria-label="뒤로">
          ‹
        </a>
      )}
      <h1 className="bar-title">{title}</h1>
      {children && <div className="bar-right">{children}</div>}
    </header>
  );
}

export function Section({ label, count, tone, children }: { label: string; count?: number; tone?: Tone; children: ReactNode }) {
  return (
    <section className={`section${tone ? ` section-${tone}` : ""}`}>
      <h2 className="section-label">
        {label}
        {count !== undefined && <span className="section-count">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <p className="empty-sub">{children}</p>}
    </div>
  );
}

export function shortPath(p: string) {
  const home = p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
  const parts = home.split("/").filter(Boolean);
  return parts.length <= 2 ? home : `…/${parts.slice(-2).join("/")}`;
}

export const repoName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export function timeAgo(iso: string, now = Date.now()) {
  const d = (now - new Date(iso).getTime()) / 1000;
  if (d < 60) return "방금";
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  return `${Math.floor(d / 86400)}일 전`;
}
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * Sidebar time: today keeps the relative form (방금, 3분 전), older days in
 * the week show a clock time (어제 14:02, 월 09:10) so same-title rows differ,
 * and anything older falls back to 일 전.
 */
export function threadTime(iso: string, now = Date.now()) {
  const d = new Date(iso);
  const n = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400000);
  if (diff <= 0) return timeAgo(iso, now);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diff === 1) return `어제 ${hhmm}`;
  if (diff < 7) return `${WEEKDAY[d.getDay()]} ${hhmm}`;
  return timeAgo(iso, now);
}

/** Compact duration: 0.4초, 12초, 3분 5초, 1시간 2분. */
export function duration(ms: number) {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}초`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return m < 10 && s % 60 ? `${m}분 ${s % 60}초` : `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}시간 ${m % 60}분` : `${h}시간`;
  return `${Math.floor(h / 24)}일`;
}

export const elapsed = (from: string, to: string | null | undefined, now: number) =>
  duration(Math.max(0, (to ? new Date(to).getTime() : now) - new Date(from).getTime()));

/** Re-renders every `ms` so elapsed times keep moving. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Runs an async action with a busy flag, sending failures to the toast. */
export function useBusy(notify: (m: string) => void) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err: any) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  };
  return [busy, act] as const;
}

const FOCUSABLE = 'a[href], button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Modal focus handling for drawers and sheets: focus moves in on open, Tab and Shift+Tab stay inside,
 * Escape closes, and focus returns to whatever opened it.
 */
export function useFocusTrap(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const list = items();
      if (list.length === 0) return;
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const inside = ref.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose]);
  return ref;
}
