import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeStore } from "./fake-store.js";
import { getLinkWithText, saveLink } from "./links.js";
import type { LinkSearch, SearchFilters, SearchTrace } from "./search.js";
import { searchLinks } from "./search-links.js";
import { OPEN_WINDOW_MS, type SearchLog, type SearchLogEntry } from "./search-log.js";

const NOW = new Date("2026-10-12T12:00:00Z");

class RecordingLog implements SearchLog {
  recorded: { owner: string; by: string; entry: SearchLogEntry; at: Date }[] = [];
  paired: {
    owner: string;
    by: string;
    link: { id: string; urlKey: string };
    since: Date;
    at: Date;
  }[] = [];
  async record(owner: string, by: string, entry: SearchLogEntry, at: Date) {
    this.recorded.push({ owner, by, entry, at });
  }
  async pairOpen(
    owner: string,
    by: string,
    link: { id: string; urlKey: string },
    since: Date,
    at: Date,
  ) {
    this.paired.push({ owner, by, link, since, at });
  }
}

class ThrowingLog implements SearchLog {
  async record(): Promise<void> {
    throw new Error("disk full");
  }
  async pairOpen(): Promise<void> {
    throw new Error("disk full");
  }
}

/** Returns fixed ids; fires its trace like the real search does: for word queries only. */
class TracingSearch implements LinkSearch {
  constructor(
    private ids: string[],
    private trace: SearchTrace = {
      mode: "hybrid",
      embedded: "solar",
      modelKey: "m",
      similarity: {},
      meaningCandidates: 0,
    },
  ) {}
  async search(
    _o: string,
    query: string,
    _f: SearchFilters,
    _l: number,
    trace?: (t: SearchTrace) => void,
  ) {
    if (/\w/.test(query)) trace?.(this.trace);
    return this.ids;
  }
}

async function setup(search: LinkSearch, log: SearchLog | undefined) {
  const store = new FakeStore();
  const now = () => NOW;
  const saved = [];
  for (const n of [1, 2]) {
    saved.push(
      (await saveLink({ store, now }, "a", { url: `https://ex.com/${n}`, savedBy: "t" })).link,
    );
  }
  return { deps: { store, search, searchLog: log, now, pages: store }, saved };
}

afterEach(() => vi.restoreAllMocks());

describe("searchLinks logging", () => {
  it("logs a word search with the trace, the filters and the links returned", async () => {
    const log = new RecordingLog();
    const trace: SearchTrace = {
      mode: "hybrid",
      embedded: "solar power",
      modelKey: "m",
      similarity: { "link-2": 0.75 },
      meaningCandidates: 4,
    };
    const { deps, saved } = await setup(new TracingSearch(["link-1", "link-2", "99"], trace), log);
    const [first, second] = saved;
    await searchLinks(deps, "a", { query: "solar power", tag: "Home Battery" }, "claude");
    expect(log.recorded).toEqual([
      {
        owner: "a",
        by: "claude",
        at: NOW,
        entry: {
          query: "solar power",
          filters: { tagKey: "home battery" },
          mode: "hybrid",
          embedded: "solar power",
          modelKey: "m",
          meaningCandidates: 4,
          results: [
            { id: "link-1", urlKey: first?.urlKey, similarity: null },
            { id: "link-2", urlKey: second?.urlKey, similarity: 0.75 },
          ],
        },
      },
    ]);
  });

  it("C2-T3: logs nothing for a blank query", async () => {
    const log = new RecordingLog();
    const { deps } = await setup(new TracingSearch(["link-1"]), log);
    await searchLinks(deps, "a", { query: "  " }, "claude");
    expect(log.recorded).toEqual([]);
  });

  it("C2-T9: logs nothing when the search never fires its trace (no searchable word)", async () => {
    const log = new RecordingLog();
    const { deps } = await setup(new TracingSearch([]), log);
    await searchLinks(deps, "a", { query: "?!" }, "claude");
    expect(log.recorded).toEqual([]);
  });

  it("C2-T11: logs a fallback with the embedded text", async () => {
    const log = new RecordingLog();
    const fallback: SearchTrace = {
      mode: "fallback",
      embedded: "solar",
      modelKey: "m",
      similarity: {},
      meaningCandidates: 0,
    };
    const { deps } = await setup(new TracingSearch(["link-1"], fallback), log);
    await searchLinks(deps, "a", { query: "solar" }, "claude");
    expect(log.recorded[0]?.entry).toMatchObject({ mode: "fallback", embedded: "solar" });
  });

  it("C2-T4: a failing log is reported and the search result is unchanged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, saved } = await setup(new TracingSearch(["link-1", "link-2"]), new ThrowingLog());
    const links = await searchLinks(deps, "a", { query: "solar" }, "claude");
    expect(links.map((l) => l.id)).toEqual(saved.map((l) => l.id));
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).toContain("[search-log]");
  });

  it("works with no log", async () => {
    const { deps } = await setup(new TracingSearch(["link-1"]), undefined);
    expect(await searchLinks(deps, "a", { query: "solar" }, "claude")).toHaveLength(1);
  });
});

describe("getLinkWithText logging", () => {
  it("pairs the found link with the agent's latest search, within the window", async () => {
    const log = new RecordingLog();
    const { deps, saved } = await setup(new TracingSearch([]), log);
    const link = saved[0];
    await getLinkWithText(deps, "a", link?.id ?? "", "claude");
    expect(log.paired).toEqual([
      {
        owner: "a",
        by: "claude",
        link: { id: link?.id, urlKey: link?.urlKey },
        since: new Date(NOW.getTime() - OPEN_WINDOW_MS),
        at: NOW,
      },
    ]);
  });

  it("C2-T8: a link that is not found pairs nothing", async () => {
    const log = new RecordingLog();
    const { deps } = await setup(new TracingSearch([]), log);
    await expect(getLinkWithText(deps, "a", "99", "claude")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(log.paired).toEqual([]);
  });

  it("C2-T8: another owner's link pairs nothing", async () => {
    const log = new RecordingLog();
    const { deps, saved } = await setup(new TracingSearch([]), log);
    await expect(getLinkWithText(deps, "b", saved[0]?.id ?? "", "claude")).rejects.toBeDefined();
    expect(log.paired).toEqual([]);
  });

  it("C2-T4: a failing log is reported and the link is returned unchanged", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps, saved } = await setup(new TracingSearch([]), new ThrowingLog());
    const got = await getLinkWithText(deps, "a", saved[0]?.id ?? "", "claude");
    expect(got.link).toEqual(saved[0]);
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).toContain("[search-log]");
  });
});
