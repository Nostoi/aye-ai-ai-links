import { afterEach } from "vitest";
import { describeStatsReadingStoreContract } from "../core/stats-reading-store-contract.js";
import { openDatabase } from "./database.js";
import { SqliteStatsReadingStore } from "./sqlite-stats-readings.js";
import { SqliteStore } from "./sqlite-store.js";

const open: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

describeStatsReadingStoreContract("SqliteStatsReadingStore", () => {
  const db = openDatabase(":memory:");
  open.push(db);
  const links = new SqliteStore(db);
  return {
    links,
    remover: links,
    readings: new SqliteStatsReadingStore(db),
    addOwner: (o) => links.ensureUser(o, o),
  };
});
