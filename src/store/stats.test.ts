import { afterEach, describe, expect, it } from "vitest";
import { at } from "../core/snapshot-store-contract.js";
import { describeStatsStoreContract } from "../core/stats-store-contract.js";
import { openDatabase } from "./database.js";
import { SqliteStatsStore } from "./sqlite-stats.js";
import { SqliteStore } from "./sqlite-store.js";

const open: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

describeStatsStoreContract("SqliteStatsStore", () => {
  const db = openDatabase(":memory:");
  open.push(db);
  const start = at(1234);
  db.prepare("UPDATE stats_meta SET tracking_since = ?").run(start.getTime());
  const links = new SqliteStore(db);
  return {
    links,
    remover: links,
    stats: new SqliteStatsStore(db),
    start,
    addOwner: (o) => links.ensureUser(o, o),
  };
});

describe("SqliteStatsStore", () => {
  it("trackingSince reads the migration's own row on a fresh database", async () => {
    const db = openDatabase(":memory:");
    open.push(db);
    const before = Date.now();
    const since = await new SqliteStatsStore(db).trackingSince();
    expect(since.getTime()).toBeLessThanOrEqual(Date.now());
    expect(since.getTime()).toBeGreaterThan(before - 60_000);
  });
});
