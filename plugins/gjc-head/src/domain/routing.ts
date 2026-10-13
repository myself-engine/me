// Routing rules of the head: when to skip judging, when to answer directly, which harness to use.
// Pure functions only; no I/O.
import type { Judgement, Route } from "./types.ts";

export const FAST_PATH_MAX_CHARS = 40;

const WORK_STEMS_KO = [
  "파일", "코드", "수정", "추가", "만들어", "고쳐", "리뷰", "커밋", "배포", "테스트",
  "붙여넣", "붙여", "붙이", "넣어", "넣", "구현", "개선", "바꿔", "바꾸", "변경",
  "지워", "지우", "삭제", "설치", "적용", "정리", "작성", "업데이트", "연결", "리팩터",
  "버그", "에러", "오류", "기능", "빌드", "실행", "돌려", "생성", "세팅", "설정",
  "마이그레이션", "올려", "구성",
];
const WORK_WORDS_EN = /\b(?:add(?:s|ed|ing)?|implement(?:s|ed|ing|ation)?|fix(?:es|ed|ing)?|refactor(?:s|ed|ing)?|build(?:s|ing)?|install(?:s|ed|ing|ation)?|deploy(?:s|ed|ing)?|updat(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|creat(?:e|es|ed|ing)|paste(?:s|d|ing)?|set\s*up)\b/i;
const WORK_SIGNALS: RegExp[] = [
  /`/,
  // Paths: ~/x, ./x, ../x, /x/y, a/b
  /(^|[\s(])(~|\.{1,2})?\/[\w.-]/,
  /[\w.-]+\/[\w.-]+/,
  // File extensions such as main.ts, README.md
  /(^|[^.])\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|go|rs|java|kt|swift|rb|php|c|h|cpp|cs|sh|ya?ml|toml|css|scss|html|sql|txt|lock|env)\b/i,
  /\b(PR|repo|README)s?\b/i,
];

/** True when the text mentions files, code or work the head would have to delegate. */
export function hasWorkSignal(text: string): boolean {
  const compact = text.replace(/\s+/gu, "");
  return WORK_STEMS_KO.some((stem) => compact.includes(stem)) || WORK_WORDS_EN.test(text) || WORK_SIGNALS.some((re) => re.test(text));
}

const CLEAR_CHAT_KO = [
  /^(?:안녕(?:하세요)?|ㅎㅇ|반가워(?:요)?|고마워(?:요)?|감사합니다|감사해요|잘\s*지내(?:요)?|좋아(?:요)?|괜찮아(?:요)?|ㅇㅇ|ㅇㅋ|ㅋ+)(?:\s+잘\s*지내(?:요)?)?(?:[.!?。！？~\s]*)$/u,
  /(?:뭐야|뭔데|뭐지|뭐하지|누구야|왜\s*.+|어떻게\s*.+|무슨\s*뜻(?:이야|인가요|이죠)?|뜻이\s*뭐|차이|알려\s*줘|설명해\s*줘)(?:[.!?。！？\s]*)$/u,
];
const CLEAR_CHAT_EN = /^(?:hi|hello|hey|thanks|thank you|what(?:'s| is) up|who(?:'s| is) (?:me|you)|who are (?:you|we|they)|what(?:'s| is) .+|why .+|how .+|difference between .+|explain .+)[.!?]*$/i;

/** Only an unmistakable greeting or plain information question skips summarize and jev. */
export function isClearlyChat(text: string): boolean {
  const t = text.trim();
  return CLEAR_CHAT_KO.some((pattern) => pattern.test(t)) || CLEAR_CHAT_EN.test(t);
}

/** Short, clearly conversational text with no work signals skips summarize and jev. */
export function isFastPath(normalized: string): boolean {
  const t = normalized.trim();
  return t.length > 0 && t.length <= FAST_PATH_MAX_CHARS && isClearlyChat(t) && !hasWorkSignal(t);
}

/** Judgement shown for fast-path messages so the UI still renders a badge. */
export function fastPathJudgement(): Judgement {
  return { simpleProb: 1, confidence: 1, source: "fast-path", model: "rule" };
}

/** Anything that needs files is delegated; otherwise direct only when clearly simple. Uncertain means delegate. */
export function decideRoute(p: { needsCodeChange: boolean; simpleProb: number; threshold: number }): Route {
  return !p.needsCodeChange && p.simpleProb >= p.threshold ? "direct" : "delegate";
}

export interface HarnessChoice {
  harness: string;
  /** True when the decider's amend replaced the suggestion. */
  amended: boolean;
}

/** The decider's amend.harness wins when it names a known harness; otherwise the suggestion stands. */
export function chooseHarness(p: { suggested: string; harnesses: string[]; amend?: Record<string, unknown> | null }): HarnessChoice {
  const wanted = p.amend?.harness;
  if (typeof wanted === "string" && wanted !== p.suggested && p.harnesses.includes(wanted)) return { harness: wanted, amended: true };
  return { harness: p.suggested, amended: false };
}
