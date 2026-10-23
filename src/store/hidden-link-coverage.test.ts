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

const HIDDEN_LINK_COVERAGE: Record<string, Coverage> = {
  link_checks: { test: RUNNER_AND_BYTE_READS },
  link_edits: { test: HIDDEN_WRITES },
  link_events: { test: HIDDEN_WRITES },
  link_images: { test: RUNNER_AND_BYTE_READS },
  link_tags: {
    reason: "read only for link rows a guarded links read already returned (TAG_SELECT)",
  },
  link_tools: { test: DIGEST_AND_HANDY },
  link_vectors: { test: RUNNER_AND_BYTE_READS },
  owner_images: { test: RUNNER_AND_BYTE_READS },
  saved_copies: { test: COPY_PAGE_READS },
  saved_copy_images: { test: COPY_PAGE_READS },
  snapshots: { test: RUNNER_AND_BYTE_READS },
};

describe("hidden-link coverage", () => {
  it("every table keyed by link id is registered", () => {
    const db = openDatabase(":memory:");
    const tables = db
      .prepare(
        `SELECT m.name FROM sqlite_master m WHERE m.type = 'table'
           AND (EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name) f WHERE f."table" = 'links')
             OR EXISTS (SELECT 1 FROM pragma_table_info(m.name) c WHERE c.name = 'link_id'))
         ORDER BY m.name`,
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
