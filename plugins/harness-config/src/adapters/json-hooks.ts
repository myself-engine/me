// Command hooks in JSON settings: Claude Code (~/.claude/settings.json) and Codex (~/.codex/hooks.json).
// Both were checked read-only against this machine's files on 2026-10-12 and share one shape:
//   hooks.<Event> = [ { matcher?, hooks: [ { type: "command", command, timeout? } ] } ]
// Observed events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure (Claude),
// PermissionRequest, Stop. Event names are passed through unchecked; a harness ignores ones it lacks.
// Uncertain: Codex `timeout` (this machine's hooks.json only uses type/command), so it is written only
// when the source declares one. Codex also needs `[features] hooks = true` and trusts each hook by hash
// in config.toml ([hooks.state]); we never touch either, so Codex may ask to trust a new or changed hook.
//
// Hook entries carry no name, so the source owns an entry by a trailing shell comment on its command:
//   "command": "<command> # me:harness-config <name>"
// Both harnesses run commands through a shell (the existing commands here use quoting and `&&`), so
// the comment changes nothing at run time. Unmarked entries are the user's and are never touched,
// even when their text equals a source hook. Inside an owned entry only type/command/timeout are
// owned; other keys (statusMessage, async, ...) survive. Groups and events are pruned only when an
// owned entry was the last thing in them.
import type { Change } from "../domain/diff.ts";
import { toHook, type Hook, type Target } from "../domain/model.ts";
import { RefusedError, type HarnessConfigFile } from "../ports/index.ts";
import { detectIndent, mergeEntry, parseObject } from "./json-mcp.ts";

const MARK = " # me:harness-config ";
const MARK_RE = /^([\s\S]*?) # me:harness-config ([A-Za-z0-9._-]+)$/;
const OWNED = ["type", "command", "timeout"];

type Entry = Record<string, any>;
type Group = { matcher?: string; hooks?: Entry[] } & Record<string, unknown>;

const ownedName = (e: unknown): string | null =>
  e && typeof e === "object" && typeof (e as Entry).command === "string" ? (MARK_RE.exec((e as Entry).command)?.[2] ?? null) : null;

function toNative(name: string, h: Hook): Entry {
  return { type: "command", command: `${h.command}${MARK}${name}`, ...(h.timeout !== undefined ? { timeout: h.timeout } : {}) };
}

function section(obj: Record<string, any>, path: string): Record<string, unknown> {
  const hooks = obj.hooks;
  if (hooks === undefined) return {};
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new RefusedError(`${path}: hooks is not an object`);
  for (const [event, groups] of Object.entries(hooks))
    if (!Array.isArray(groups)) throw new RefusedError(`${path}: hooks.${event} is not a list`);
  return hooks as Record<string, unknown>;
}

export function jsonHooksFile(target: Target, path: string): HarnessConfigFile<Hook> {
  return {
    target,
    path,
    read(text) {
      if (text === null || !text.trim()) return {};
      const out: Record<string, Hook> = {};
      for (const [event, groups] of Object.entries(section(parseObject(text, path), path)))
        for (const g of groups as Group[])
          for (const e of Array.isArray(g?.hooks) ? g.hooks : []) {
            const m = typeof e?.command === "string" ? MARK_RE.exec(e.command) : null;
            if (!m) continue;
            out[m[2]!] = toHook({
              event,
              matcher: typeof g.matcher === "string" ? g.matcher : undefined,
              command: m[1]!,
              timeout: typeof e.timeout === "number" ? e.timeout : undefined,
            });
          }
      return out;
    },
    render(text, change: Change<Hook>) {
      const obj = text && text.trim() ? parseObject(text, path) : {};
      const original = section(obj, path) as Record<string, Group[]>;
      const hooks: Record<string, Group[]> = Object.fromEntries(
        Object.entries(original).map(([ev, gs]) => [ev, (gs as Group[]).map((g) => (g && Array.isArray(g.hooks) ? { ...g, hooks: [...g.hooks] } : g))]),
      );
      const touched = new Set([...Object.keys(change.upsert), ...change.remove]);
      const placed = new Set<string>();
      // Replace in place when the entry already sits under the same event and matcher.
      for (const [event, groups] of Object.entries(hooks))
        for (const g of groups) {
          if (!Array.isArray(g?.hooks)) continue;
          const kept: Entry[] = [];
          for (const e of g.hooks) {
            const name = ownedName(e);
            if (name === null || !touched.has(name)) kept.push(e);
            else {
              const h = change.upsert[name];
              if (h && !placed.has(name) && h.event === event && h.matcher === (typeof g.matcher === "string" ? g.matcher : undefined)) {
                kept.push(mergeEntry(e, toNative(name, h), OWNED));
                placed.add(name);
              }
            }
          }
          g.hooks = kept;
        }
      // Prune groups and events that held only owned entries we just took out.
      for (const [event, groups] of Object.entries(hooks)) {
        const before = original[event]!;
        const left = groups.filter((g, i) => !(Array.isArray(g?.hooks) && g.hooks.length === 0 && (before[i]?.hooks ?? []).some((e) => ownedName(e) !== null)));
        if (left.length) hooks[event] = left;
        else if (before.length) delete hooks[event];
      }
      for (const [name, h] of Object.entries(change.upsert)) {
        if (placed.has(name)) continue;
        (hooks[h.event] ??= []).push({ ...(h.matcher !== undefined ? { matcher: h.matcher } : {}), hooks: [toNative(name, h)] });
      }
      obj.hooks = hooks;
      const trailing = text === null || text.endsWith("\n") ? "\n" : "";
      return JSON.stringify(obj, null, detectIndent(text ?? "")) + trailing;
    },
  };
}
