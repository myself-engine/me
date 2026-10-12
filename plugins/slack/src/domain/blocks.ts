// Card → Block Kit JSON. Pure data, so the field limits Slack enforces are checked here, not in the adapter.
import type { Card, Row } from "./render.ts";
import { truncate } from "./split.ts";

/** Slack rejects a section text over 3000 characters and button or option text over 75. */
export const SECTION_MAX = 3000;
const LABEL_MAX = 75;
const plain = (text: string) => ({ type: "plain_text" as const, text: text.slice(0, LABEL_MAX), emoji: true });

function actions(row: Row): Record<string, unknown> {
  return {
    type: "actions",
    elements: row.map((c) => {
      if (c.type === "button") {
        return { type: "button", action_id: c.id, text: plain(c.label), value: c.id, ...(c.style === "default" ? {} : { style: c.style }) };
      }
      const options = c.options.slice(0, 100).map((o) => ({ text: plain(o.label), value: o.value }));
      const initial = options.find((_, i) => c.options[i]!.selected);
      return { type: "static_select", action_id: c.id, placeholder: plain(c.placeholder), options, ...(initial ? { initial_option: initial } : {}) };
    }),
  };
}

export function toBlocks(card: Card): Record<string, unknown>[] {
  return [{ type: "section", text: { type: "mrkdwn", text: truncate(card.text, SECTION_MAX) } }, ...card.rows.map(actions)];
}
