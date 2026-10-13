// One LLM call: normalized Korean → English structured task summary (DESIGN §6 step 2).
// The brief doubles as the delegation instruction for a worker harness.
import { join } from "node:path";
import { definePlugin } from "@me/sdk";
import { isHeadHarness, parseJsonObject, runHead, type HeadHarness } from "@me/runner";
import { normalizeCommitSubject } from "./subject.ts";

export interface Summary {
  summaryEn: string;
  brief: string;
  needsCodeChange: boolean;
  scope: "none" | "single-file" | "few-files" | "project" | "unknown";
  harness: string;
  harnessReason: string;
  /** One observable English sentence saying when the work is done; passed to brgr as --criterion. */
  criterion: string;
  /** Kind of work, used by approval risk tiers (approval-policy). */
  role: "none" | "test" | "code" | "docs" | "research" | "deploy" | "db-write";
  /** Short English imperative git subject (<=60 chars, no trailing period); "" when no work is needed. */
  commitSubject: string;
  /** True when a consequential detail needs the user before this task can be delegated. */
  ambiguous: boolean;
  /** Up to two concise questions; each has two to four options, with the recommended default first. */
  questions: { q: string; options: string[] }[];
}

const dataDir = process.env.ME_DATA_DIR ?? ".";

const plugin = definePlugin({
  methods: {
    summarize: async (p: { original: string; normalized: string; harnesses: string[]; project?: string }, ctx) => {
      const model = (plugin.config.model as string) ?? "openai-codex/gpt-5.6-luna";
      // Follows the head's harness when the operator sets the same value here (own config, no cross-plugin call).
      const harness: HeadHarness = isHeadHarness(plugin.config.harness) ? plugin.config.harness : "gjc";
      const prompt = [
        "You turn a user's chat message to their coding-agent orchestrator into a structured English task summary.",
        "The user writes casual Korean. Interpret intent, not literal words. Output ONLY one JSON object, no prose.",
        "",
        `Original message: ${JSON.stringify(p.original)}`,
        `Normalized Korean: ${JSON.stringify(p.normalized)}`,
        `Project directory (may be empty): ${JSON.stringify(p.project ?? "")}`,
        `Available worker harnesses: ${JSON.stringify(p.harnesses)}`,
        "",
        "JSON fields:",
        '- "summaryEn": one or two plain English sentences stating what the user wants. Use positive phrasing.',
        '- "brief": if work is needed, a self-contained English instruction a coding agent could execute in the project; otherwise "".',
        '- "needsCodeChange": true if fulfilling it requires reading, running, or changing files or commands.',
        '- "scope": one of "none", "single-file", "few-files", "project", "unknown".',
        '- "harness": the best worker harness id from the list for this task (pick the first if nothing stands out).',
        '- "harnessReason": a few words why.',
        '- "criterion": if work is needed, one observable English sentence that says when the work is done (e.g. "bun test passes and the README lists the new flag."); otherwise "".',
        '- "role": one of "none", "test" (only runs or writes tests), "code", "docs", "research", "deploy" (ships or releases anything), "db-write" (changes a database). Pick the most dangerous that applies.',
        '- "commitSubject": if work is needed, a short English imperative git subject for the work, at most 60 characters, no trailing period (e.g. "Add multiply function with a test"); otherwise "".',
        '- "ambiguous": true only when a materially different outcome depends on missing information and the user should answer before delegation; otherwise false.',
        '- "questions": when ambiguous, an array of at most two short Korean questions, each with two to four concise options; put the recommended default first. Otherwise an empty array. Do not ask about details a worker can safely decide.',
      ].join("\n");
      const res = await runHead({ harness, prompt, model, cwd: join(dataDir, "runs"), ephemeral: true, thinking: "low", signal: ctx.signal });
      const s = parseJsonObject<Summary>(res.text);
      if (!p.harnesses.includes(s.harness)) s.harness = p.harnesses[0] ?? s.harness;
      s.criterion = typeof s.criterion === "string" ? s.criterion.trim() : "";
      s.commitSubject = normalizeCommitSubject(s.commitSubject);
      const roles = ["none", "test", "code", "docs", "research", "deploy", "db-write"] as const;
      // Unknown roles count as code: never let a parse slip make work look safer than it is.
      s.role = roles.includes(s.role as any) ? s.role : "code";
      return s;
    },
  },
});
await plugin.run();
