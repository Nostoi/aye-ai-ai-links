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
    faviconRow: (o, id) => {
      const r = db
        .prepare(
          `SELECT candidates, status, generation, discovery, bytes IS NOT NULL AS stored
           FROM link_favicons WHERE owner_id = ? AND link_id = ?`,
        )
        .get(o, Number(id)) as
        | {
            candidates: string;
            status: string;
            generation: number;
            discovery: number;
            stored: number;
          }
        | undefined;
      return r
        ? { ...r, candidates: JSON.parse(r.candidates) as string[], stored: r.stored === 1 }
        : null;
    },
    seedFavicon: (o, id, row) => {
      db.prepare(
        `UPDATE link_favicons SET status = ?, discovery = ?, generation = coalesce(?, generation),
           content_type = ?, bytes = ?, sha256 = ?, fetched_at = ?
         WHERE owner_id = ? AND link_id = ?`,
      ).run(
        row.status,
        row.discovery,
        row.generation ?? null,
        ...(row.status === "ok"
          ? ["image/png", Buffer.from([1]), "seeded", 5]
          : [null, null, null, null]),
        o,
        Number(id),
      );
    },
    forgetIconCheck: (o, id) => {
      db.prepare("UPDATE snapshots SET image_status = NULL WHERE owner_id = ? AND link_id = ?").run(
        o,
        Number(id),
      );
    },
  };
});
