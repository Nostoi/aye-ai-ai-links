import type { Database } from "better-sqlite3";
import type { Embedder } from "./search/embedder.js";
import { FtsSearch } from "./search/fts-search.js";
import { HybridSearch } from "./search/hybrid-search.js";
import { DIMS, MODEL_KEY } from "./search/model.js";
import { loadVectorFunctions, VectorSearch } from "./search/vector-search.js";
import { SqliteProfileStore } from "./store/profile-store.js";
import { SqliteSearchLog } from "./store/search-log.js";
import { SqliteImageStore } from "./store/sqlite-image-store.js";
import { SqliteStore } from "./store/sqlite-store.js";
import { SqliteVectorIndex } from "./store/sqlite-vector-index.js";

/**
 * Builds the store, search, search log, vector index, image store, profile and page-text reader from ONE database handle.
 * They must share it: ids ranked or saved in one database and read through another come back as the
 * wrong links, or with another link's page text.
 */
export function createDeps(db: Database, embedder: Embedder) {
  const store = new SqliteStore(db);
  const keywordSearch = new FtsSearch(db);
  loadVectorFunctions(db);
  return {
    store,
    search: new HybridSearch(keywordSearch, new VectorSearch(db, MODEL_KEY), embedder, MODEL_KEY),
    /** The keyword half of `search` alone, for the digest's focus matching until #68. */
    keywordSearch,
    /** Counts what a blank listing pages through; blank listings are keyword search's alone. */
    count: keywordSearch,
    searchLog: new SqliteSearchLog(db),
    vectorIndex: new SqliteVectorIndex(db, DIMS),
    /** Preview images: the image pass writes them, the web door reads them. */
    images: new SqliteImageStore(db),
    profile: new SqliteProfileStore(db),
    pages: store,
    /** Keep handy rows: the digest and the tools rules read them. */
    tools: store,
    now: () => new Date(),
  };
}

export type AppDeps = ReturnType<typeof createDeps>;
