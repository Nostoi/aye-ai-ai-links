import { afterEach, describe, expect, it, vi } from "vitest";
import {
  logOpenFromReceipt,
  OPEN_WINDOW_MS,
  type ReceiptRow,
  type SearchLog,
  type SearchLogEntry,
} from "./search-log.js";
import { fromOwnPage, SearchReceipts } from "./search-receipts.js";

const T0 = new Date("2026-11-15T12:00:00Z");
const entry = (...ids: string[]): SearchLogEntry => ({
  query: "solar",
  filters: {},
  mode: "keyword",
  embedded: null,
  modelKey: null,
  meaningCandidates: 0,
  limit: 20,
  results: ids.map((id) => ({ id, urlKey: `ex.com/${id}`, similarity: null, ranks: {} })),
});

afterEach(() => vi.restoreAllMocks());

describe("SearchReceipts", () => {
  const make = (max?: number) => {
    let now = T0;
    let n = 0;
    const receipts = new SearchReceipts({ now: () => now, token: () => `t${++n}`, max });
    const advance = (ms: number) => {
      now = new Date(now.getTime() + ms);
    };
    return { receipts, advance };
  };

  it("finds an entry for its owner, and for no one else", () => {
    const { receipts } = make();
    const token = receipts.issue("a", entry("1"));
    expect(receipts.find("a", token)).toEqual({ entry: entry("1"), at: T0 });
    expect(receipts.find("b", token)).toBeUndefined();
    expect(receipts.find("a", "unknown")).toBeUndefined();
  });

  it("forgets an entry once the open window has passed", () => {
    const { receipts, advance } = make();
    const token = receipts.issue("a", entry("1"));
    advance(OPEN_WINDOW_MS - 1);
    expect(receipts.find("a", token)).toBeDefined();
    advance(1);
    expect(receipts.find("a", token)).toBeUndefined();
  });

  it("keeps at most `max` entries, dropping the oldest first", () => {
    const { receipts } = make(3);
    const tokens = [1, 2, 3, 4].map((n) => receipts.issue("a", entry(String(n))));
    expect(tokens.map((t) => receipts.find("a", t) !== undefined)).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });

  it("defaults to 200 entries", () => {
    const { receipts } = make();
    const tokens = Array.from({ length: 201 }, () => receipts.issue("a", entry("1")));
    expect(receipts.find("a", tokens[0] ?? "")).toBeUndefined();
    expect(receipts.find("a", tokens[1] ?? "")).toBeDefined();
  });

  it("issues unguessable tokens by default", () => {
    const a = new SearchReceipts().issue("a", entry("1"));
    const b = new SearchReceipts().issue("a", entry("1"));
    expect(a).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(a).not.toBe(b);
  });
});

describe("fromOwnPage", () => {
  it.each([
    [undefined, true],
    ["same-origin", true],
    ["none", true],
    ["same-site", false],
    ["cross-site", false],
    ["", false],
  ])("Sec-Fetch-Site %j is %s", (site, own) => {
    expect(fromOwnPage(site)).toBe(own);
  });
});

/** An in-memory log holding one receipt row. */
class OneRowLog implements SearchLog {
  paired: string[] = [];
  constructor(private row: ReceiptRow | null) {}
  async record() {}
  async pairOpen() {}
  async receiptRow() {
    return this.row;
  }
  async pairReceipt(_o: string, _r: string, link: { id: string }) {
    this.paired.push(link.id);
  }
}

describe("logOpenFromReceipt", () => {
  const row = (over: Partial<ReceiptRow> = {}): ReceiptRow => ({
    by: "web",
    createdAt: T0,
    openedLinkId: null,
    resultIds: ["1", "2"],
    ...over,
  });
  const open = (log: SearchLog, id: string, at = new Date(T0.getTime() + 1000)) =>
    logOpenFromReceipt(log, "a", "web", "r1", undefined, { id, urlKey: `ex.com/${id}` }, at);

  it("pairs a result of the owner's unpaired web row inside the window", async () => {
    const log = new OneRowLog(row());
    await open(log, "2");
    expect(log.paired).toEqual(["2"]);
  });

  it.each([
    ["a link that was not a result", row(), "9"],
    ["a row an agent wrote", row({ by: "claude" }), "1"],
    ["a row already paired", row({ openedLinkId: "1" }), "1"],
    ["a row older than the window", row({ createdAt: new Date(T0.getTime() - 1) }), "1"],
    ["no row", null, "1"],
  ])("does not pair %s", async (_name, found, id) => {
    const log = new OneRowLog(found);
    await open(log, id, new Date(T0.getTime() + OPEN_WINDOW_MS));
    expect(log.paired).toEqual([]);
  });

  it("reports a failing log and does not throw", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = new OneRowLog(row());
    log.receiptRow = async () => {
      throw new Error("disk full");
    };
    await expect(open(log, "1")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
  });
});
