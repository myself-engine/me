// gjc-head chat.send op.update kinds → progress reactions on the user's message.

export const REACTIONS = {
  received: "👀",
  judging: "🤔",
  answering: "✍️",
  delegated: "📤",
  done: "✅",
  error: "⚠️",
} as const;

export type Stage = keyof typeof REACTIONS;

export function stageOf(update: { kind?: string; state?: string } | null | undefined): Stage | null {
  switch (update?.kind) {
    case "understood":
    case "summary":
    case "judgement":
      return "judging";
    case "text_delta":
      return "answering";
    case "delegation":
      return update.state === "delegated" ? "delegated" : null;
    case "error":
      return "error";
    default:
      return null;
  }
}
