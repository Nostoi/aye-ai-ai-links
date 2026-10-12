import { afterEach, describe, expect, it } from "vitest";
import { saveLink } from "../core/links.js";
import type { SearchTrace } from "../core/search.js";
import { openDatabase } from "../store/database.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { FtsSearch, queryKind } from "./fts-search.js";

describe("queryKind", () => {
  it("tells blank, no-word and word queries apart", () => {
    expect(queryKind("")).toBe("blank");
    expect(queryKind(" \t\u0007 ")).toBe("blank");
    expect(queryKind("?! --")).toBe("no_words");
    expect(queryKind("solar ?!")).toBe("words");
  });
});

describe("FtsSearch.parts", () => {
  const dbs: ReturnType<typeof openDatabase>[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) if (db.open) db.close();
  });

  async function setup() {
    const db = openDatabase(":memory:");
    dbs.push(db);
    const store = new SqliteStore(db);
    store.ensureUser("o", "o");
    let clock = 1;
    const deps = { store, now: () => new Date(clock++) };
    const own = async (n: number, title: string) => {
      const { link } = await saveLink(deps, "o", {
        url: `https://ex.com/${n}`,
        title,
        savedBy: "t",
      });
      return link.id;
    };
    const paged = async (n: number, text: string) => {
      const id = await own(n, `plain ${n}`);
      db.prepare("UPDATE snapshots SET text = ? WHERE link_id = ?").run(text, id);
      return id;
    };
    return { search: new FtsSearch(db), own, paged };
  }

  it("caps fields at the limit and pageOnly at the depth, without repeating fields", async () => {
    const { search, own, paged } = await setup();
    const a = await own(1, "solar one");
    const b = await own(2, "solar two");
    await paged(3, "solar words");
    await paged(4, "solar more");
    const p5 = await paged(5, "solar again");
    const wide = search.parts("o", "solar", {}, 3, 10);
    expect([...wide.fields].sort()).toEqual([String(a), String(b)].sort());
    expect(wide.pageOnly).toHaveLength(3);
    expect(wide.pageOnly).not.toContain(String(a));
    expect(search.parts("o", "solar", {}, 3, 2).pageOnly).toHaveLength(2);
    expect(wide.pageOnly).toContain(String(p5));
  });

  it("returns an empty pageOnly when fields fill the limit", async () => {
    const { search, own, paged } = await setup();
    await own(1, "solar one");
    await own(2, "solar two");
    await paged(3, "solar page");
    const parts = search.parts("o", "solar", {}, 2, 10);
    expect(parts.fields).toHaveLength(2);
    expect(parts.pageOnly).toEqual([]);
  });

  it("search reports a keyword trace for word queries only", async () => {
    const { search, own } = await setup();
    await own(1, "solar one");
    const traces: SearchTrace[] = [];
    const trace = (t: SearchTrace) => traces.push(t);
    await search.search("o", "", {}, 5, trace);
    await search.search("o", "?!", {}, 5, trace);
    expect(traces).toEqual([]);
    await search.search("o", "solar", {}, 5, trace);
    expect(traces).toEqual([
      { mode: "keyword", embedded: null, modelKey: null, similarity: {}, meaningCandidates: 0 },
    ]);
  });
});
