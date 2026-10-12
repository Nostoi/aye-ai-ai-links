import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { filingContext } from "../core/filing-context.js";
import { saveLink, updateLink } from "../core/links.js";
import type { SearchFilters } from "../core/search.js";
import { searchLinks } from "../core/search-links.js";
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

  it("finds a link by a project an agent created while saving, and lists it as active", async () => {
    const s = setup();
    const { link } = await saveLink(s.deps, "a", {
      url: "https://ex.com/p",
      savedBy: "t",
      tags: [{ name: "Home Batteries", source: "stated", kind: "project" }],
    });
    await s.save("a", { title: "other", tags: ["home batteries topic"] });
    const deps = { store: s.deps.store, search: s.search };
    const found = await searchLinks(deps, "a", { query: "", project: "home batteries" }, "t");
    expect(found.map((l) => l.id)).toEqual([link.id]);
    const ctx = await filingContext(s.deps, "a");
    expect(ctx.activeProjects.map((t) => t.key)).toEqual(["home batteries"]);
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

  it("matches non-ASCII letters", async () => {
    const s = setup();
    const id = await s.save("a", { title: "日本 notes" });
    expect(await s.find("日本")).toEqual([id]);
  });

  it("lists links for a query made only of control characters", async () => {
    const s = setup();
    const id = await s.save("a", { title: "quokka" });
    expect(await s.find("\u0000")).toEqual([id]);
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

  it("follows a title change", async () => {
    const s = setup();
    const id = await s.save("a", { title: "quokka" });
    await updateLink(s.deps, "a", id, { title: "numbat" });
    expect(await s.find("quokka")).toEqual([]);
    expect(await s.find("numbat")).toEqual([id]);
    await updateLink(s.deps, "a", id, { title: null });
    expect(await s.find("numbat")).toEqual([]);
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

  it("keeps tag names in position order, not tag-creation order", async () => {
    const s = setup();
    await s.save("a", { tags: ["alpha", "beta"] });
    const id = await s.save("a", { tags: ["beta", "alpha"] });
    const row = s.db.prepare("SELECT tags FROM link_search WHERE rowid = ?").get(Number(id));
    expect(row).toEqual({ tags: "beta alpha" });
  });

  it("forgets a tag when the link loses all its tags", async () => {
    const s = setup();
    const id = await s.save("a", { tags: ["wombat"] });
    await updateLink(s.deps, "a", id, { tags: [] });
    expect(await s.find("wombat")).toEqual([]);
  });

  it("forgets only the dropped tag when a link keeps another", async () => {
    const s = setup();
    const id = await s.save("a", { tags: ["wombat", "numbat"] });
    await updateLink(s.deps, "a", id, { tags: [{ name: "numbat", source: "stated" }] });
    expect(await s.find("wombat")).toEqual([]);
    expect(await s.find("numbat")).toEqual([id]);
  });

  it("moves a tag to another link when link_tags.link_id changes", async () => {
    const s = setup();
    const from = await s.save("a", { tags: ["wombat"] });
    const to = await s.save("a", { title: "plain" });
    s.db
      .prepare("UPDATE link_tags SET link_id = ? WHERE link_id = ?")
      .run(Number(to), Number(from));
    expect(await s.find("wombat")).toEqual([to]);
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

describe("FtsSearch page text", () => {
  type S = ReturnType<typeof setup>;
  const page = (s: S, id: string, f: { title?: string; description?: string; text?: string }) =>
    s.db
      .prepare("UPDATE snapshots SET title = ?, description = ?, text = ? WHERE link_id = ?")
      .run(f.title ?? null, f.description ?? null, f.text ?? null, Number(id));
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `w${i % 997}`).join(" ");

  it("ranks a title match above a link that matches only in page text, long page or short", async () => {
    const s = setup();
    const longPage = await s.save("a", { title: "Quokka field guide" });
    page(s, longPage, { text: filler(5000) });
    const shortPage = await s.save("a", { title: "Holiday notes" });
    page(s, shortPage, { text: `saw a quokka ${filler(40)}` });
    const noPage = await s.save("a", { title: "Quokka trip plan" });
    for (let i = 0; i < 30; i++) {
      const id = await s.save("a", { title: "Other" });
      page(s, id, { text: filler(800) });
    }
    expect(await s.find("quokka")).toEqual([noPage, longPage, shortPage]);
  });

  it("lists page-only matches after owner-field matches, best page match first", async () => {
    const s = setup();
    await addFiller(s);
    const weak = await s.save("a", { title: "x" });
    page(s, weak, { text: `numbat ${filler(60)}` });
    const strong = await s.save("a", { title: "y" });
    page(s, strong, { text: "numbat numbat numbat" });
    const own = await s.save("a", { summary: "numbat" });
    expect(await s.find("numbat")).toEqual([own, strong, weak]);
  });

  it("finds a page's own title and description", async () => {
    const s = setup();
    const id = await s.save("a", { title: "x" });
    page(s, id, { title: "Wallaby notes", description: "marsupial census" });
    expect(await s.find("wallaby")).toEqual([id]);
    expect(await s.find("marsupial")).toEqual([id]);
  });

  it("returns a link once when it matches in its fields and in its page", async () => {
    const s = setup();
    const both = await s.save("a", { title: "numbat" });
    page(s, both, { text: "numbat" });
    expect(await s.find("numbat")).toEqual([both]);
  });

  it("applies the limit across both lists", async () => {
    const s = setup();
    const own = await s.save("a", { title: "numbat" });
    const p1 = await s.save("a", { title: "x" });
    page(s, p1, { text: "numbat" });
    const p2 = await s.save("a", { title: "y" });
    page(s, p2, { text: "numbat numbat" });
    expect(await s.find("numbat", {}, "a", 2)).toEqual([own, p2]);
    expect(await s.find("numbat", {}, "a", 1)).toEqual([own]);
    expect(await s.find("numbat", {}, "a", 3)).toHaveLength(3);
  });

  it("fills the limit with page-only matches when a link matches in both places", async () => {
    const s = setup();
    const both = await s.save("a", { title: "numbat", at: 1_000 });
    page(s, both, { text: "numbat" });
    const only = await s.save("a", { title: "x", at: 2_000 });
    page(s, only, { text: "numbat" });
    expect(await s.find("numbat", {}, "a", 2)).toEqual([both, only]);
  });

  it("never returns another owner's page text", async () => {
    const s = setup();
    const theirs = await s.save("b", { title: "x" });
    page(s, theirs, { text: "numbat" });
    expect(await s.find("numbat", {}, "a")).toEqual([]);
    expect(await s.find("numbat", {}, "b")).toEqual([theirs]);
  });

  it("applies the tag, project and date filters to page-only matches", async () => {
    const s = setup();
    const early = await s.save("a", { title: "x", tags: ["alpha"], at: 1_000 });
    const late = await s.save("a", { title: "y", tags: ["beta"], at: 3_000 });
    for (const id of [early, late]) page(s, id, { text: "numbat" });
    s.db.prepare("UPDATE tags SET kind = 'project' WHERE owner_id = 'a' AND key = 'beta'").run();
    expect(await s.find("numbat", { tagKey: "alpha" })).toEqual([early]);
    expect(await s.find("numbat", { projectKey: "beta" })).toEqual([late]);
    expect(await s.find("numbat", { projectKey: "alpha" })).toEqual([]);
    expect(await s.find("numbat", { savedFrom: new Date(2_000) })).toEqual([late]);
    expect(await s.find("numbat", { savedTo: new Date(2_000) })).toEqual([early]);
  });

  it("keeps the blank-query listing and no-word result unchanged", async () => {
    const s = setup();
    const id = await s.save("a", { title: "x" });
    page(s, id, { text: "numbat" });
    expect(await s.find("")).toEqual([id]);
    expect(await s.find("!!!")).toEqual([]);
  });
});
