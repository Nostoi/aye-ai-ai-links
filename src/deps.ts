import type { Database } from "better-sqlite3";
import { createReadGate } from "./core/copy-reading.js";
import { writeExport } from "./core/export.js";
import { createExportBuilds } from "./core/export-builds.js";
import type { Embedder } from "./search/embedder.js";
import { FtsSearch } from "./search/fts-search.js";
import { HybridSearch } from "./search/hybrid-search.js";
import { DIMS, MODEL_KEY } from "./search/model.js";
import { loadVectorFunctions, VectorSearch } from "./search/vector-search.js";
import { ExportFolder } from "./store/export-folder.js";
import { SqliteProfileStore } from "./store/profile-store.js";
import { SqliteSavedCopyStore } from "./store/saved-copies.js";
import { SqliteSearchLog } from "./store/search-log.js";
import { SqliteImageStore } from "./store/sqlite-image-store.js";
import { SqliteLinkCheckStore } from "./store/sqlite-link-checks.js";
import { SqliteLinkEditStore } from "./store/sqlite-link-edits.js";
import { SqliteStatsStore } from "./store/sqlite-stats.js";
import { SqliteStore } from "./store/sqlite-store.js";
import { SqliteVectorIndex } from "./store/sqlite-vector-index.js";

/**
 * Builds the store, search, search log, vector index, image store, edit store, check store, profile, saved-copy store (which owns the folder) and page-text reader from ONE database handle.
 * They must share it: ids ranked or saved in one database and read through another come back as the
 * wrong links, or with another link's page text. The export builds read through these same deps.
 */
export function createDeps(
  db: Database,
  embedder: Embedder,
  savedCopyDir: string | null = null,
  exportDir: string | null = null,
) {
  const store = new SqliteStore(db);
  const keywordSearch = new FtsSearch(db);
  loadVectorFunctions(db);
  const base = {
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
    /** The owner's title, picture and tag edits and their Undo (#145, #239). */
    edits: new SqliteLinkEditStore(db),
    profile: new SqliteProfileStore(db),
    pages: store,
    /** Keep handy rows: the digest and the tools rules read them. */
    tools: store,
    /** Dead-link checks (#128): the check runner writes them; the digest and Keep handy read them. */
    checks: new SqliteLinkCheckStore(db),
    /** The event log and its start, for the Stats counts (#161). */
    stats: new SqliteStatsStore(db),
    /** Saved copies: one instance per process, so it owns the folder and its checked state. Without a folder (tests) copies read as missing and none are written. */
    savedCopies: new SqliteSavedCopyStore(db, savedCopyDir),
    /** The one saved-copy read gate: the copy pass and the copy pages share it. */
    readGate: createReadGate(),
    now: () => new Date(),
  };
  /** The private folder of finished exports. Without one (tests) every build fails. */
  const exportFolder = new ExportFolder(exportDir);
  return {
    ...base,
    exportFolder,
    /** One export build per owner at a time (#130), written into `exportFolder`. */
    exports: createExportBuilds({
      build: (owner, sink, stop) => writeExport(base, owner, sink, stop),
      files: exportFolder,
      now: base.now,
      log: (line) => console.error(line),
    }),
  };
}

export type AppDeps = ReturnType<typeof createDeps>;
