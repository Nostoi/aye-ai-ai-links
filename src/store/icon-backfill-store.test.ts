import type Database from "better-sqlite3";
import { afterEach } from "vitest";
import { describeIconBackfillStoreContract } from "../core/icon-backfill-store-contract.js";
import { openDatabase } from "./database.js";
import { SqliteImageStore } from "./sqlite-image-store.js";
import { SqliteLinkCheckStore } from "./sqlite-link-checks.js";
import { SqliteLinkEditStore } from "./sqlite-link-edits.js";
import { SqliteStore } from "./sqlite-store.js";

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

describeIconBackfillStoreContract("SqliteImageStore icon backfill", () => {
  const db = openDatabase(":memory:");
  open.push(db);
  const links = new SqliteStore(db);
  return {
    links,
    images: new SqliteImageStore(db),
    checks: new SqliteLinkCheckStore(db),
    edits: new SqliteLinkEditStore(db),
    addOwner: (o) => links.ensureUser(o, o),
    imageStatus: (o, id) =>
      (db
        .prepare("SELECT image_status FROM snapshots WHERE owner_id = ? AND link_id = ?")
        .pluck()
        .get(o, Number(id)) as string | null | undefined) ?? null,
    forgetIconCheck: (o, id) => {
      db.prepare("UPDATE snapshots SET image_status = NULL WHERE owner_id = ? AND link_id = ?").run(
        o,
        Number(id),
      );
    },
  };
});
