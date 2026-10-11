import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { saveLink, updateLink } from "../core/links.js";
import type { SearchFilters } from "../core/search.js";
import { openDatabase } from "../store/database.js";
import { MIGRATIONS, migrate } from "../store/migrations.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { FtsSearch } from "./fts-search.js";

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

type Fields = {
  title?: string;
  summary?: string;
  why?: string;
  tags?: string[];
  at?: number;
};

function setup() {
  const db = openDatabase(":memory:");
  open.push(db);
  const store = new SqliteStore(db);
  for (const o of ["a", "b"]) store.ensureUser(o, o);
  let clock = 1_000;
  let n = 0;
  const deps = { store, now: () => new Date(clock) };
  const search = new FtsSearch(db);
  const save = async (owner: string, f: Fields = {}) => {
    clock = f.at ?? clock + 1;
    const { link } = await saveLink(deps, owner, {
      url: `https://ex.com/${n++}`,
      title: f.title ?? null,
      summary: f.summary ?? null,
      why: f.why ? { text: f.why, source: "stated" } : null,
      tags: (f.tags ?? []).map((name) => ({ name, source: "stated" as const })),
      savedBy: "t",
    });
    return link.id;
  };
  const find = (q: string, filters: SearchFilters = {}, owner = "a", limit = 50) =>
    search.search(owner, q, filters, limit);
  return { db, deps, save, find, search };
}

/** Unrelated links so the matched words are rare, which keeps bm25 scores meaningful. */
async function addFiller(s: ReturnType<typeof setup>) {
  for (let i = 0; i < 6; i++) await s.save("a", { title: `filler${i}`, summary: `pad${i}` });
}

describe("FtsSearch matching", () => {
  it("stems: sleep finds Sleeping", async () => {
    const s = setup();
    const id = await s.save("a", { title: "Sleeping better" });
    expect(await s.find("sleep")).toEqual([id]);
  });

  it("matches prefixes", async () => {
    const s = setup();
    const id = await s.save("a", { title: "Home battery guide" });
    expect(await s.find("batt")).toEqual([id]);
  });

  it("searches summary, why and tag names", async () => {
    const s = setup();
    const sum = await s.save("a", { summary: "quokka" });
    const why = await s.save("a", { why: "numbat" });
    const tag = await s.save("a", { tags: ["wombat"] });
    expect(await s.find("quokka")).toEqual([sum]);
    expect(await s.find("numbat")).toEqual([why]);
    expect(await s.find("wombat")).toEqual([tag]);
  });

  it("includes archived links", async () => {
    const s = setup();
    const id = await s.save("a", { title: "quokka" });
    await updateLink(s.deps, "a", id, { state: "archived" });
    expect(await s.find("quokka")).toEqual([id]);
  });

  it("honours the limit", async () => {
    const s = setup();
    await s.save("a", { title: "quokka" });
    const newest = await s.save("a", { title: "quokka" });
    expect(await s.find("quokka", {}, "a", 1)).toEqual([newest]);
  });
});

describe("FtsSearch ranking", () => {
  it("ranks a title match above a summary match of equal length", async () => {
    const s = setup();
    await addFiller(s);
    const inTitle = await s.save("a", { title: "quokka", summary: "pad" });
    const inSummary = await s.save("a", { title: "pad", summary: "quokka" });
    // The summary match is newer, so recency alone would put it first.
    expect(await s.find("quokka")).toEqual([inTitle, inSummary]);
  });

  it("ranks two matched words above one in equal-length documents", async () => {
    const s = setup();
    await addFiller(s);
    const both = await s.save("a", { summary: "quokka numbat" });
    const one = await s.save("a", { summary: "quokka pad" });
    expect(await s.find("quokka numbat")).toEqual([both, one]);
  });

  it("breaks exact ties by newest saved, then highest id", async () => {
    const s = setup();
    const first = await s.save("a", { title: "quokka", at: 5_000 });
    const second = await s.save("a", { title: "quokka", at: 5_000 });
    const newer = await s.save("a", { title: "quokka", at: 6_000 });
    expect(await s.find("quokka")).toEqual([newer, second, first]);
    expect(await s.find("")).toEqual([newer, second, first]);
  });
});

describe("FtsSearch isolation", () => {
  it("never returns another owner's link or same-named tag", async () => {
    const s = setup();
    const mine = await s.save("a", { title: "quokka", tags: ["Solar"] });
    await s.save("b", { title: "quokka", tags: ["Solar"] });
    expect(await s.find("quokka")).toEqual([mine]);
    expect(await s.find("quokka", { tagKey: "solar" })).toEqual([mine]);
    expect(await s.find("")).toEqual([mine]);
    expect(await s.find("", { tagKey: "solar" })).toEqual([mine]);
  });
});

describe("FtsSearch filters", () => {
  it("filters by tag, in a query and in a blank listing", async () => {
    const s = setup();
    const tagged = await s.save("a", { title: "quokka", tags: ["Solar"] });
    await s.save("a", { title: "quokka", tags: ["wind"] });
    expect(await s.find("quokka", { tagKey: "solar" })).toEqual([tagged]);
    expect(await s.find("", { tagKey: "solar" })).toEqual([tagged]);
  });

  it("matches the project filter only for project-kind tags", async () => {
    const s = setup();
    const topicLink = await s.save("a", { title: "quokka", tags: ["alpha"] });
    const projectLink = await s.save("a", { title: "quokka", tags: ["beta"] });
    s.db.prepare("UPDATE tags SET kind = 'project' WHERE owner_id = 'a' AND key = 'beta'").run();
    expect(await s.find("quokka", { projectKey: "beta" })).toEqual([projectLink]);
    expect(await s.find("quokka", { projectKey: "alpha" })).toEqual([]);
    expect(await s.find("", { projectKey: "alpha" })).toEqual([]);
    expect(await s.find("quokka", { tagKey: "alpha" })).toEqual([topicLink]);
  });

  it("treats date bounds as inclusive instants", async () => {
    const s = setup();
    const early = await s.save("a", { title: "quokka", at: 1_000 });
    const mid = await s.save("a", { title: "quokka", at: 2_000 });
    const late = await s.save("a", { title: "quokka", at: 3_000 });
    const from = new Date(2_000);
    const to = new Date(3_000);
    expect(await s.find("quokka", { savedFrom: from })).toEqual([late, mid]);
    expect(await s.find("quokka", { savedTo: new Date(2_000) })).toEqual([mid, early]);
    expect(await s.find("quokka", { savedFrom: from, savedTo: from })).toEqual([mid]);
    expect(await s.find("", { savedFrom: from, savedTo: to })).toEqual([late, mid]);
    expect(await s.find("", { savedFrom: new Date(2_001), savedTo: new Date(2_999) })).toEqual([]);
  });
});

describe("FtsSearch query handling", () => {
  it.each([
    "home-battery",
    "what: sleep",
    "c++",
    'sleep thing "from',
    "AND",
    "sleep OR",
    "NEAR(",
    "sleep\u0000thing",
  ])("runs %j without throwing", async (q) => {
    const s = setup();
    await s.save("a", { title: "sleep" });
    await expect(s.find(q)).resolves.toBeInstanceOf(Array);
  });

  it("finds words around a hyphen or a NUL", async () => {
    const s = setup();
    const battery = await s.save("a", { title: "Home battery setup" });
    const sleep = await s.save("a", { title: "sleep" });
    const thing = await s.save("a", { title: "thing" });
    expect(await s.find("home-battery")).toEqual([battery]);
    expect([...(await s.find("sleep\u0000thing"))].sort()).toEqual([sleep, thing].sort());
  });

  it("returns [] for a query with no searchable word, but lists for a blank one", async () => {
    const s = setup();
    const older = await s.save("a", { title: "quokka" });
    const newer = await s.save("a", { title: "numbat" });
    expect(await s.find("?!")).toEqual([]);
    expect(await s.find("   ")).toEqual([newer, older]);
    expect(await s.find("")).toEqual([newer, older]);
  });
});

describe("FtsSearch index upkeep", () => {
  it("follows a summary change", async () => {
    const s = setup();
    const id = await s.save("a", { summary: "quokka" });
    await updateLink(s.deps, "a", id, { summary: "numbat" });
    expect(await s.find("quokka")).toEqual([]);
    expect(await s.find("numbat")).toEqual([id]);
  });

  it("follows tag replacement", async () => {
    const s = setup();
    const id = await s.save("a", { tags: ["wombat"] });
    await updateLink(s.deps, "a", id, { tags: [{ name: "numbat", source: "stated" }] });
    expect(await s.find("wombat")).toEqual([]);
    expect(await s.find("numbat")).toEqual([id]);
  });

  it("follows a duplicate save that fills a missing why", async () => {
    const s = setup();
    const id = await s.save("a", { title: "x" });
    await saveLink(s.deps, "a", {
      url: "https://ex.com/0",
      savedBy: "t",
      why: { text: "quokka", source: "stated" },
    });
    expect(await s.find("quokka")).toEqual([id]);
  });

  it("follows a direct link_tags update", async () => {
    const s = setup();
    const id = await s.save("a", { tags: ["wombat"] });
    await s.save("a", { tags: ["numbat"] });
    s.db
      .prepare(
        "UPDATE link_tags SET tag_id = (SELECT id FROM tags WHERE key = 'numbat') WHERE link_id = ?",
      )
      .run(Number(id));
    expect(await s.find("wombat")).toEqual([]);
    expect((await s.find("numbat")).includes(id)).toBe(true);
  });

  it("follows a tag rename", async () => {
    const s = setup();
    const id = await s.save("a", { tags: ["wombat"] });
    s.db.prepare("UPDATE tags SET name = 'Numbat' WHERE key = 'wombat'").run();
    expect(await s.find("wombat")).toEqual([]);
    expect(await s.find("numbat")).toEqual([id]);
  });

  it("drops a deleted link, leaving no orphan id", async () => {
    const s = setup();
    // A link without tags has no link_tags row whose cascade could clean the index.
    const bare = await s.save("a", { title: "quokka" });
    const tagged = await s.save("a", { title: "quokka", tags: ["wombat"] });
    s.db.prepare("DELETE FROM links WHERE id IN (?, ?)").run(Number(bare), Number(tagged));
    expect(await s.find("quokka")).toEqual([]);
    expect(await s.find("wombat")).toEqual([]);
    expect(s.db.prepare("SELECT count(*) AS n FROM link_search").get()).toEqual({ n: 0 });
  });

  it("keeps tag names in position order", async () => {
    const s = setup();
    await s.save("a", { tags: ["beta", "alpha"] });
    const row = s.db.prepare("SELECT tags FROM link_search").get();
    expect(row).toEqual({ tags: "beta alpha" });
  });
});

describe("migration 2", () => {
  it("backfills links saved before it ran", async () => {
    const db = new Database(":memory:");
    open.push(db);
    db.pragma("foreign_keys = ON");
    migrate(db, MIGRATIONS.slice(0, 1));
    db.exec(`
      INSERT INTO users VALUES ('a', 'a', 0);
      INSERT INTO links (id, owner_id, url, url_key, title, saved_at, saved_by, state)
        VALUES (7, 'a', 'https://ex.com/7', 'ex.com/7', 'quokka', 1, 't', 'active');
      INSERT INTO tags (id, owner_id, key, name, kind) VALUES (3, 'a', 'wombat', 'Wombat', 'topic');
      INSERT INTO link_tags VALUES ('a', 7, 3, 'stated', 0);
    `);
    migrate(db);
    const search = new FtsSearch(db);
    expect(await search.search("a", "quokka", {}, 10)).toEqual(["7"]);
    expect(await search.search("a", "wombat", {}, 10)).toEqual(["7"]);
  });
});
