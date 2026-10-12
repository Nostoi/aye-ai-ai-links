import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.js";
import { saveLink } from "./links.js";
import type { LinkSearch, SearchFilters } from "./search.js";
import { searchLinks } from "./search-links.js";

class StubSearch implements LinkSearch {
  calls: { owner: string; query: string; filters: SearchFilters; limit: number }[] = [];
  constructor(public ids: string[] = []) {}
  async search(owner: string, query: string, filters: SearchFilters, limit: number) {
    this.calls.push({ owner, query, filters, limit });
    return this.ids;
  }
}

async function setup(ids: string[] = []) {
  const store = new FakeStore();
  const search = new StubSearch(ids);
  const now = () => new Date(0);
  const saved = [];
  for (const n of [1, 2, 3]) {
    saved.push(
      (await saveLink({ store, now }, "a", { url: `https://ex.com/${n}`, savedBy: "t" })).link,
    );
  }
  return { deps: { store, search }, search, saved };
}

const invalid = expect.objectContaining({ code: "invalid_input" });

describe("searchLinks", () => {
  it("normalizes tag and project names to keys and passes the rest on", async () => {
    const { deps, search } = await setup();
    const from = new Date(1);
    const to = new Date(2);
    await searchLinks(
      deps,
      "a",
      {
        query: "sleep",
        tag: "  Home   Batteries ",
        project: " Sleep ",
        savedFrom: from,
        savedTo: to,
      },
      "t",
    );
    expect(search.calls).toEqual([
      {
        owner: "a",
        query: "sleep",
        filters: { tagKey: "home batteries", projectKey: "sleep", savedFrom: from, savedTo: to },
        limit: 20,
      },
    ]);
  });

  it("keeps the search order and drops ids the store does not return", async () => {
    const { deps, saved } = await setup(["link-3", "link-99", "link-1"]);
    const links = await searchLinks(deps, "a", { query: "x" }, "t");
    expect(links.map((l) => l.id)).toEqual([saved[2]?.id, saved[0]?.id]);
  });

  it("drops ids that belong to another owner", async () => {
    const { deps } = await setup(["link-1"]);
    expect(await searchLinks(deps, "b", { query: "x" }, "t")).toEqual([]);
  });

  it("refuses bad input without calling search", async () => {
    const { deps, search } = await setup();
    const cases = [
      { savedFrom: new Date(Number.NaN) },
      { savedTo: new Date(Number.NaN) },
      { savedFrom: new Date(5), savedTo: new Date(4) },
      { tag: "   " },
      { project: "" },
      { limit: 1.5 },
      { limit: Number.NaN },
      { limit: Number.POSITIVE_INFINITY },
    ];
    for (const extra of cases) {
      await expect(searchLinks(deps, "a", { query: "x", ...extra }, "t")).rejects.toEqual(invalid);
    }
    expect(search.calls).toEqual([]);
  });

  it("accepts equal date bounds", async () => {
    const { deps, search } = await setup();
    await searchLinks(deps, "a", { query: "", savedFrom: new Date(5), savedTo: new Date(5) }, "t");
    expect(search.calls).toHaveLength(1);
  });

  it.each([
    [0, 1],
    [500, 50],
    [undefined, 20],
    [7, 7],
  ])("clamps limit %s to %s", async (given, used) => {
    const { deps, search } = await setup();
    await searchLinks(deps, "a", { query: "x", limit: given }, "t");
    expect(search.calls[0]?.limit).toBe(used);
  });
});
