// Deterministic slang expansion (DESIGN §6 step 1). No LLM, no cost.

export interface SlangEntry {
  from: string;
  to: string;
  /** Match inside words too (e.g. verb endings like 하셈). Jamo-only keys always match anywhere. */
  anywhere?: boolean;
}

export const DEFAULT_DICT: SlangEntry[] = [
  { from: "ㄱㄱ", to: "시작하자" },
  { from: "ㅇㅇ", to: "응" },
  { from: "ㄴㄴ", to: "아니" },
  { from: "ㄹㅇ", to: "진짜" },
  { from: "ㅇㅋ", to: "오케이" },
  { from: "ㄱㅊ", to: "괜찮아" },
  { from: "ㅈㅅ", to: "미안" },
  { from: "ㅎㅇ", to: "안녕" },
  { from: "ㅁㄹ", to: "모르겠어" },
  { from: "억까", to: "일부러 반대 입장에서 공격해 봐" },
  { from: "하셈", to: "해 줘", anywhere: true },
  { from: "존나", to: "정말" },
  { from: "개좋", to: "정말 좋", anywhere: true },
];

const JAMO_ONLY = /^[ㄱ-ㆎ]+$/u;
const BOUNDARY = "(^|[\\s.,!?~()\\[\\]\"'`])";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface NormalizeResult {
  normalized: string;
  replaced: { from: string; to: string }[];
}

export function normalize(text: string, dict: SlangEntry[]): NormalizeResult {
  const replaced: NormalizeResult["replaced"] = [];
  // Longer keys first so "개좋" wins over a hypothetical "개".
  const entries = [...dict].sort((a, b) => b.from.length - a.from.length);
  let out = text;
  for (const e of entries) {
    const anywhere = e.anywhere || JAMO_ONLY.test(e.from);
    const re = anywhere ? new RegExp(escape(e.from), "gu") : new RegExp(BOUNDARY + escape(e.from), "gu");
    let hit = false;
    out = out.replace(re, (...m) => {
      hit = true;
      return anywhere ? e.to : `${m[1]}${e.to}`;
    });
    if (hit) replaced.push({ from: e.from, to: e.to });
  }
  return { normalized: out, replaced };
}
