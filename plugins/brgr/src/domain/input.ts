import { redactString } from "@me/redact";
import type { QuestionKind, TaskQuestion } from "./question.ts";
import type { BrgrMessage } from "../ports/index.ts";

const MAX_QUESTION = 1200;
const MAX_OPTIONS = 8;
const bounded = (s: string) => redactString(s).trim().slice(-MAX_QUESTION);

export function parseMessages(raw: string): BrgrMessage[] {
  try {
    const value = JSON.parse(raw) as unknown;
    const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as any).messages) ? (value as any).messages : [];
    return list.filter((m: any) => m && typeof m.body === "string" && typeof m.from === "string").map((m: any) => ({
      id: String(m.id ?? m.message_id ?? ""), kind: String(m.kind ?? "note"), from: m.from, to: String(m.to ?? "owner"), body: m.body, at: m.at,
    }));
  } catch {
    return [];
  }
}

export function latestWorkerQuestion(messages: BrgrMessage[]): BrgrMessage | null {
  const worker = messages.filter((m) => m.from === "worker");
  for (let i = worker.length - 1; i >= 0; i--) if (worker[i]!.kind === "question") return worker[i]!;
  return worker.at(-1) ?? null;
}

export function optionsFromBody(body: string): string[] | undefined {
  const lines = body.split("\n");
  const options = lines.map((line) => line.match(/^\s*(?:\d+[.)]|[-*])\s+(.+?)\s*$/)?.[1]).filter((v): v is string => !!v);
  return options.length >= 2 ? options.slice(0, MAX_OPTIONS).map((s) => bounded(s)) : undefined;
}

export function kindFromBody(body: string): QuestionKind {
  return optionsFromBody(body) ? "menu" : "message";
}

export function questionFromMessage(m: Pick<BrgrMessage, "id" | "body" | "at">, at: string): TaskQuestion | null {
  const text = bounded(m.body);
  if (!text) return null;
  const options = optionsFromBody(text);
  return { id: m.id || `message:${stableId(text)}`, text, at: m.at ?? at, kind: options ? "menu" : "message", ...(options ? { options } : {}) };
}

export function questionFromStatus(raw: string, at: string): TaskQuestion | null {
  try {
    const value = JSON.parse(raw) as any;
    const pane = value?.task?.pane ?? value?.pane;
    if (typeof pane !== "string" || !pane.trim()) return null;
    const text = bounded(pane.split("\n").slice(-12).join("\n"));
    if (!text) return null;
    const options = optionsFromBody(text);
    return { id: `screen:${stableId(text)}`, text, at, kind: options ? "menu" : "screen", ...(options ? { options } : {}) };
  } catch {
    return null;
  }
}

function stableId(value: string) {
  let hash = 2166136261;
  for (const ch of value) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}
