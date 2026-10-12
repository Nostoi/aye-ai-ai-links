import { afterEach, describe, expect, it, vi } from "vitest";
import { saveLink } from "../core/links.js";
import type { SearchTrace } from "../core/search.js";
import { createDeps } from "../deps.js";
import { openDatabase } from "../store/database.js";
import type { Embedder } from "./embedder.js";
import { FakeEmbedder } from "./embedder.js";
import { FtsSearch, queryKind } from "./fts-search.js";
import { DIMS, MODEL_KEY } from "./model.js";

const OWNER = "o";

describe("stop words in keyword matching (#66)", () => {
  const dbs: ReturnType<typeof openDatabase>[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const db of dbs.splice(0)) if (db.open) db.close();
  });

  function setup(embedder: Embedder = new FakeEmbedder(DIMS)) {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = openDatabase(":memory:");
    dbs.push(db);
    const deps = createDeps(db, embedder);
    deps.store.ensureUser(OWNER, OWNER);
    let n = 0;
    const own = async (title: string) =>
      (await saveLink(deps, OWNER, { url: `https://ex.com/${n++}`, title, savedBy: "t" })).link.id;
    const paged = async (text: string) => {
      const id = await own(`plain ${n}`);
      db.prepare("UPDATE snapshots SET text = ? WHERE link_id = ?").run(text, id);
      return id;
    };
    /** Stores the vector of `text` for a link, so meaning search can find it. */
    const vectorize = async (id: string, text: string) => {
      const [v] = await new FakeEmbedder(DIMS).embedDocuments([text]);
      const f = v as Float32Array;
      db.prepare("INSERT INTO link_vectors VALUES (?, ?, ?, ?, 'h', ?, 0)").run(
        OWNER,
        Number(id),
        MODEL_KEY,
        f.length,
        Buffer.from(f.buffer),
      );
    };
    const fts = new FtsSearch(db);
    const fields = (q: string) => fts.parts(OWNER, q, {}, 50, 50).fields;
    const pages = (q: string) => fts.parts(OWNER, q, {}, 50, 50).pageOnly;
    return { deps, own, paged, vectorize, fields, pages };
  }

  async function crowded(prefix: string, query: string) {
    const s = setup();
    for (let i = 0; i < 20; i++) await s.own(`${prefix} ${i}`);
    const target = await s.own("Car maintenance");
    for (let i = 1; i <= 21; i++) await s.vectorize(String(i), i === 21 ? query : `other ${i}`);
    const traces: SearchTrace[] = [];
    const ids = await s.deps.search.search(OWNER, query, {}, 20, (t) => traces.push(t));
    return { ids, target, mode: traces[0]?.mode };
  }

  it("T1: twenty links sharing a filler word do not crowd out the meaning match", async () => {
    const { ids, target, mode } = await crowded("This and that", "that automobile");
    expect(mode).toBe("hybrid");
    expect(ids[0]).toBe(target);
  });

  it("T7: a slash-joined filler pair does not crowd out the meaning match", async () => {
    const { ids, target, mode } = await crowded("that this", "that/this automobile");
    expect(mode).toBe("hybrid");
    expect(ids[0]).toBe(target);
  });

  it("an underscore-joined filler pair does not crowd out the meaning match", async () => {
    const { ids, target, mode } = await crowded("that this", "that_this automobile");
    expect(mode).toBe("hybrid");
    expect(ids[0]).toBe(target);
  });

  it("T2: a filler word is not a prefix match on 'apple'", async () => {
    const s = setup();
    const apple = await s.own("apple pie");
    const quokka = await s.own("quokka");
    const fields = s.fields("a quokka");
    expect(fields).toContain(quokka);
    expect(fields).not.toContain(apple);
  });

  it("T3: a query of only filler words is still searched, as typed", async () => {
    const s = setup();
    const shining = await s.own("The Shining");
    expect(queryKind("the")).toBe("words");
    expect(s.fields("the")).toEqual([shining]);
    expect(await s.deps.search.search(OWNER, "the", {}, 5)).toContain(shining);
  });

  it("T4: case and punctuation do not hide a filler word; a contraction is not one", async () => {
    const s = setup();
    const filler = await s.own("that thing");
    const quokka = await s.own("quokka");
    const raining = await s.own("it's raining");
    expect(s.fields("That, THE quokka")).toEqual(s.fields("quokka"));
    expect(s.fields("That, THE quokka")).toEqual([quokka]);
    expect(s.fields("it's quokka")).toContain(raining);
    expect(s.fields("it's quokka")).not.toContain(filler);
  });

  it("T5: page text containing only the filler word is not a page hit", async () => {
    const s = setup();
    const weather = await s.paged("the weather today");
    const quokka = await s.paged("the quokka lives here");
    const pages = s.pages("the quokka");
    expect(pages).toContain(quokka);
    expect(pages).not.toContain(weather);
  });

  it("T8: A/T is not a filler word; its fragment still matches", async () => {
    const failing: Embedder = {
      embedQuery: async () => {
        throw new Error("down");
      },
      embedDocuments: async () => [],
    };
    const s = setup(failing);
    const gearbox = await s.own("A/T gearbox service");
    expect(s.fields("A/T quokka")).toEqual([gearbox]);
    expect(await s.deps.search.search(OWNER, "A/T quokka", {}, 5)).toEqual([gearbox]);
  });

  it("T9: a filler word with an accent, precomposed or decomposed, is dropped like the plain one", async () => {
    const s = setup();
    const filler = await s.own("that tales");
    const quokka = await s.own("quokka");
    for (const word of ["thát", "thát"]) {
      expect(s.fields(`${word} quokka`)).toEqual([quokka]);
      expect(s.fields(`${word} quokka`)).not.toContain(filler);
    }
  });

  it("T10: filler words with punctuation fall back to the whole query", async () => {
    const s = setup();
    const shining = await s.own("The Shining");
    expect(queryKind("The, a!")).toBe("words");
    expect(s.fields("The, a!")).toEqual([shining]);
  });

  it("keeps a mixed fragment whole: 'that/quokka' is the phrase 'that quokka'", async () => {
    const s = setup();
    const phrase = await s.own("that quokka");
    const alone = await s.own("quokka alone");
    expect(s.fields("that/quokka")).toEqual([phrase]);
    expect(s.fields("that/quokka")).not.toContain(alone);
  });
});
