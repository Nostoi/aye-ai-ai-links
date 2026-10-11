import type { Database } from "better-sqlite3";
import { FtsSearch } from "./search/fts-search.js";
import { SqliteStore } from "./store/sqlite-store.js";

/**
 * Builds the store and search from ONE database handle. They must share it:
 * ids ranked in one database and read through another come back as the wrong links.
 */
export function createDeps(db: Database) {
  return {
    store: new SqliteStore(db),
    search: new FtsSearch(db),
    now: () => new Date(),
  };
}

export type AppDeps = ReturnType<typeof createDeps>;
