import type Database from "better-sqlite3";
import { afterEach } from "vitest";
import { describeFaviconStoreContract } from "../core/favicon-store-contract.js";
import { openDatabase } from "./database.js";
import { SqliteFaviconStore } from "./sqlite-favicons.js";
import { SqliteImageStore } from "./sqlite-image-store.js";
import { SqliteStore } from "./sqlite-store.js";

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

describeFaviconStoreContract("SqliteFaviconStore", () => {
  const db = openDatabase(":memory:");
  open.push(db);
  const links = new SqliteStore(db);
  return {
    links,
    images: new SqliteImageStore(db),
    favicons: new SqliteFaviconStore(db),
    addOwner: (o) => links.ensureUser(o, o),
    row: (o, id) => {
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
  };
});
