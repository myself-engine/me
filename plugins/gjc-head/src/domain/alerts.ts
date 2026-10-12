// Known ways a reply or delegation can stay blocked, and what the user can do.
// Pure: string in, Korean cause and fix out. The head records one alert entity
// per cause (gjc-head.alert) and shows the same text on the failed message.
export type AlertCause = "gjc-login" | "herdr-pane" | "dirty-repo" | "model-refused";

export interface FailureAlert {
  cause: AlertCause;
  title: string;
  fix: string;
}

/** The stored alert: what to show plus when, where, and whether it still blocks. */
export interface HeadAlert extends FailureAlert {
  id: AlertCause;
  detail: string;
  active: boolean;
  ts: string;
  updatedAt: string;
  threadId?: string;
  messageId?: string;
}

const textOf = (err: unknown) => (typeof err === "string" ? err : String((err as Error)?.message ?? err));

/** Maps a thrown error to its blocking cause, or null when the cause is unknown. */
export function describeFailure(err: unknown): FailureAlert | null {
  const text = textOf(err);
  if (/uncommitted changes|커밋되지 않은 변경/.test(text)) {
    return {
      cause: "dirty-repo",
      title: "대상 저장소에 커밋되지 않은 변경이 있어요",
      fix: "변경사항을 커밋하거나 stash한 뒤 다시 시도하세요",
    };
  }
  if (/Herdr|에이전트 없는|exact Herdr source|agent-free/i.test(text)) {
    return {
      cause: "herdr-pane",
      title: "커널이 에이전트 없는 Herdr pane에서 실행되지 않았어요",
      fix: "터미널에서 me를 실행하면 에이전트 없는 Herdr 창에서 다시 띄워요",
    };
  }
  if (/Claude Code에서만|is not allowed inside GJC|effort는|작업 effort는|모델 이름이 비어|Anthropic|unknown harness|not allowed/i.test(text)) {
    return {
      cause: "model-refused",
      title: "모델을 쓸 수 없어요",
      fix: "대화 설정에서 다른 모델을 고르세요",
    };
  }
  // Token-expiry English ("authentication token has expired", "token expired") and refresh prompts only count with a login context (gjc/openai/auth/…). The gate below keeps stray token errors out.
  if (/로그인.*만료|만료.*로그인|인증.*만료|만료.*인증|login[\s\S]{0,40}expir|expir[\s\S]{0,40}login|token[\s\S]{0,40}expir|expir[\s\S]{0,40}token|authentication[\s\S]{0,40}token|refresh|unauthorized|401/i.test(text) && /gjc|openai|login|로그인|인증|auth|401|unauthorized/i.test(text)) {
    return {
      cause: "gjc-login",
      title: "GJC의 OpenAI 로그인이 만료됐어요",
      fix: "터미널에서 gjc 실행 후 /login",
    };
  }
  return null;
}

/** What lands on the message: cause and fix in Korean, or the raw error when unknown. */
export function friendlyError(err: unknown): string {
  const alert = describeFailure(err);
  if (alert) return `${alert.title} · ${alert.fix}`;
  return textOf(err).slice(0, 500);
}
