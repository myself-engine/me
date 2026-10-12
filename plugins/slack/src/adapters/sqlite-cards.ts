// Posted cards live next to the ledger (same SQLite file), so a restart does not post them again.
import type { Database } from "bun:sqlite";
import type { CardStore, PostedCard } from "../ports/index.ts";

export function sqliteCards(db: Database): CardStore {
  db.exec(`CREATE TABLE IF NOT EXISTS slack_cards (
    kind TEXT NOT NULL, ref TEXT NOT NULL, origin TEXT NOT NULL, message_id TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (kind, ref))`);
  return {
    get(kind, ref) {
      const r = db.prepare("SELECT * FROM slack_cards WHERE kind = ? AND ref = ?").get(kind, ref) as any;
      return r ? { kind: r.kind, ref: r.ref, originKey: r.origin, messageId: r.message_id, data: JSON.parse(r.data) } : null;
    },
    put(c: PostedCard) {
      db.prepare("INSERT OR REPLACE INTO slack_cards VALUES (?, ?, ?, ?, ?)").run(c.kind, c.ref, c.originKey, c.messageId, JSON.stringify(c.data));
    },
  };
}
