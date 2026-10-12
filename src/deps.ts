import type { Database } from "better-sqlite3";
import type { Embedder } from "./search/embedder.js";
import { FtsSearch } from "./search/fts-search.js";
import { HybridSearch } from "./search/hybrid-search.js";
import { MODEL_KEY } from "./search/model.js";
import { loadVectorFunctions, VectorSearch } from "./search/vector-search.js";
import { SqliteProfileStore } from "./store/profile-store.js";
import { SqliteSearchLog } from "./store/search-log.js";
import { SqliteStore } from "./store/sqlite-store.js";

/**
 * Builds the store, search, search log, profile and page-text reader from ONE database handle.
 * They must share it: ids ranked or saved in one database and read through another come back as the
 * wrong links, or with another link's page text.
 */
export function createDeps(db: Database, embedder: Embedder) {
  const store = new SqliteStore(db);
  loadVectorFunctions(db);
  return {
    store,
    search: new HybridSearch(
      new FtsSearch(db),
      new VectorSearch(db, MODEL_KEY),
      embedder,
      MODEL_KEY,
    ),
    searchLog: new SqliteSearchLog(db),
    profile: new SqliteProfileStore(db),
    pages: store,
    now: () => new Date(),
  };
}

export type AppDeps = ReturnType<typeof createDeps>;
