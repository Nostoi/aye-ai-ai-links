import { afterEach } from "vitest";
import { describeIntentGuessContract } from "../core/intent-guess-store-contract.js";
import { openDatabase } from "./database.js";
import { SqliteStore } from "./sqlite-store.js";

const open: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

type Row = { link_id: number; outcome: string | null; tries: number };

describeIntentGuessContract("SqliteStore intent guesses", () => {
  const db = openDatabase(":memory:");
  open.push(db);
  const store = new SqliteStore(db);
  return {
    store,
    addOwner: (o) => store.ensureUser(o, o),
    queue: (o, id) => {
      db.prepare("INSERT INTO intent_guesses (owner_id, link_id) VALUES (?, ?)").run(o, Number(id));
    },
    rows: (o) =>
      (
        db
          .prepare(
            "SELECT link_id, outcome, tries FROM intent_guesses WHERE owner_id = ? ORDER BY link_id",
          )
          .all(o) as Row[]
      ).map((r) => ({ id: String(r.link_id), outcome: r.outcome, tries: r.tries })),
  };
});
