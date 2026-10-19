import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";

const REMOVAL_TESTS = readFileSync(new URL("./link-removal.test.ts", import.meta.url), "utf8");

const RUNNER_AND_BYTE_READS = "runner and byte reads skip a hidden link";
const DIGEST_AND_HANDY = "digest, Handy and the gone pick leave out a hidden link";
const HIDDEN_WRITES =
  "tool, edit, check, vector and copy writes refuse a hidden link and change nothing";
const COPY_PAGE_READS = "copy page reads return nothing for a hidden link";

type Coverage = { test: string } | { reason: string };

/**
 * Every table with a foreign key to `links`, and what shows that a hidden link's rows cannot
 * be read through it (a test in `link-removal.test.ts`, by title) or why no such test is needed.
 */
const HIDDEN_LINK_COVERAGE: Record<string, Coverage> = {
  link_checks: { test: RUNNER_AND_BYTE_READS },
  link_edits: { test: HIDDEN_WRITES },
  link_images: { test: RUNNER_AND_BYTE_READS },
  link_tags: {
    reason: "read only for link rows a guarded links read already returned (TAG_SELECT)",
  },
  link_tools: { test: DIGEST_AND_HANDY },
  link_vectors: { test: RUNNER_AND_BYTE_READS },
  owner_images: { test: RUNNER_AND_BYTE_READS },
  saved_copies: { test: COPY_PAGE_READS },
  snapshots: { test: RUNNER_AND_BYTE_READS },
};

describe("hidden-link coverage", () => {
  it("every table with a foreign key to links is registered", () => {
    const db = openDatabase(":memory:");
    const tables = db
      .prepare(
        `SELECT DISTINCT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) f
         WHERE m.type = 'table' AND f."table" = 'links' ORDER BY m.name`,
      )
      .pluck()
      .all();
    db.close();
    expect(tables).toEqual(Object.keys(HIDDEN_LINK_COVERAGE).sort());
  });

  it("every named test exists in link-removal.test.ts", () => {
    for (const [table, coverage] of Object.entries(HIDDEN_LINK_COVERAGE)) {
      if ("reason" in coverage) continue;
      expect(REMOVAL_TESTS, `${table}: no such test`).toContain(`it("${coverage.test}"`);
    }
  });
});
