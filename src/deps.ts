import type { Database } from "better-sqlite3";
import { FtsSearch } from "./search/fts-search.js";
import { SqliteProfileStore } from "./store/profile-store.js";
import { SqliteStore } from "./store/sqlite-store.js";

/**
 * Builds the store, search, profile and page-text reader from ONE database handle. They must
 * share it: ids ranked or saved in one database and read through another come back as the
 * wrong links, or with another link's page text.
 */
export function createDeps(db: Database) {
  const store = new SqliteStore(db);
  return {
    store,
    search: new FtsSearch(db),
    profile: new SqliteProfileStore(db),
    pages: store,
    now: () => new Date(),
  };
}

export type AppDeps = ReturnType<typeof createDeps>;
