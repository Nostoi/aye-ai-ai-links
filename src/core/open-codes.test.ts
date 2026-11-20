import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";
import { saveLink } from "./links.js";
import { openFromCode, openTarget } from "./open-codes.js";
import type { SearchLogEntry } from "./search-log.js";
import { archiveLink } from "./worth-a-look.js";

const A = "owner-a";
const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

const T = (minutes: number) => new Date(Date.UTC(2026, 10, 15, 10, minutes));

function setup() {
  const db = openDatabase(":memory:");
  open.push(db);
  let now = T(0);
  const deps = { ...createDeps(db, new FakeEmbedder(DIMS)), now: () => now };
  deps.store.ensureUser(A, A);
  const save = async (url: string) => (await saveLink(deps, A, { url, savedBy: "t" })).link;
  const searched = (by: string, query: string, ...ids: string[]) =>
    deps.searchLog.record(A, by, entryFor(query, ids), now);
  const paired = () =>
    db.prepare("SELECT query, opened_link_id AS opened FROM search_log ORDER BY id").all() as {
      query: string;
      opened: number | null;
    }[];
  const events = () =>
    db.prepare("SELECT link_id AS link, kind, at FROM link_events ORDER BY rowid").all();
  return {
    db,
    deps,
    save,
    searched,
    paired,
    events,
    setNow: (t: Date) => {
      now = t;
    },
  };
}

const entryFor = (query: string, ids: string[]): SearchLogEntry => ({
  query,
  filters: {},
  mode: "hybrid",
  embedded: query,
  modelKey: "m",
  meaningCandidates: 0,
  limit: 20,
  results: ids.map((id) => ({ id, urlKey: `k${id}`, similarity: null, ranks: { page: 1 } })),
});

describe("an opening through an open code (#133)", () => {
  it("records one opening of the owner's link at that moment", async () => {
    const { deps, save, events, setNow } = setup();
    const link = await save("https://ex.com/batteries");
    setNow(T(6));

    await openFromCode(deps, { owner: A, linkId: link.id, agent: "Claude" });

    expect((await deps.store.get(A, link.id))?.lastOpenedAt).toEqual(T(6));
    expect(events()).toEqual([{ link: Number(link.id), kind: "opened", at: T(6).getTime() }]);
  });

  it("pairs with the agent's search that showed the link, never a newer one that didn't (O1)", async () => {
    const { deps, save, searched, paired, setNow } = setup();
    const batteries = await save("https://ex.com/batteries");
    const tiles = await save("https://ex.com/tiles");
    await searched("Claude", "home batteries", batteries.id);
    setNow(T(5));
    await searched("Claude", "kitchen tiles", tiles.id);
    setNow(T(6));

    await openFromCode(deps, { owner: A, linkId: batteries.id, agent: "Claude" });

    expect(paired()).toEqual([
      { query: "home batteries", opened: Number(batteries.id) },
      { query: "kitchen tiles", opened: null },
    ]);
  });

  it("pairs nothing when only another agent's search, or one older than the window, showed it", async () => {
    const { deps, save, searched, paired, setNow } = setup();
    const link = await save("https://ex.com/batteries");
    await searched("Claude", "old batteries", link.id);
    setNow(T(31));
    await searched("ChatGPT", "home batteries", link.id);

    await openFromCode(deps, { owner: A, linkId: link.id, agent: "Claude" });

    expect(paired().map((r) => r.opened)).toEqual([null, null]);
  });

  it("leaves a search already paired as it was, and a second click pairs nothing more", async () => {
    const { deps, save, searched, paired, setNow } = setup();
    const one = await save("https://ex.com/one");
    const two = await save("https://ex.com/two");
    await searched("Claude", "both", one.id, two.id);
    setNow(T(1));

    await openFromCode(deps, { owner: A, linkId: two.id, agent: "Claude" });
    await openFromCode(deps, { owner: A, linkId: one.id, agent: "Claude" });

    expect(paired()).toEqual([{ query: "both", opened: Number(two.id) }]);
  });

  it("leaves an archived link archived, and records the opening once", async () => {
    const { deps, save, setNow, events } = setup();
    const link = await save("https://ex.com/archived");
    await archiveLink(deps, A, link.id);
    expect((await deps.store.get(A, link.id))?.state).toBe("archived");
    setNow(T(2));

    await openFromCode(deps, { owner: A, linkId: link.id, agent: "Claude" });

    expect(await deps.store.get(A, link.id)).toMatchObject({
      state: "archived",
      lastOpenedAt: T(2),
    });
    expect(events().filter((e) => (e as { kind: string }).kind === "opened")).toHaveLength(1);
  });
});

describe("an open code's target", () => {
  it("is the owner's web link, and nothing for a link that is not a web page", async () => {
    const { deps, save } = setup();
    const web = await save("https://ex.com/web");
    const bare = await save("http:ex.com/bare");

    expect((await openTarget(deps, { owner: A, linkId: web.id, agent: "Claude" }))?.id).toBe(
      web.id,
    );
    expect(await openTarget(deps, { owner: A, linkId: bare.id, agent: "Claude" })).toBeNull();
    expect(await openTarget(deps, { owner: A, linkId: "999", agent: "Claude" })).toBeNull();
  });
});
