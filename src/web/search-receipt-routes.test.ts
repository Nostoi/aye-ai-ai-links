import { describe, expect, it } from "vitest";
import { addSecondUser, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { OPEN_WINDOW_MS } from "../core/search-log.js";
import { SearchReceipts } from "../core/search-receipts.js";
import { createDeps } from "../deps.js";
import { type Embedder, FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const post = (json: unknown) => ({ method: "POST", json });

/** Counts query embeddings and fails every one after the first, so a re-run search would show. */
class OnceEmbedder implements Embedder {
  calls = 0;
  private readonly inner = new FakeEmbedder(DIMS);
  embedQuery(text: string, signal?: AbortSignal) {
    this.calls++;
    if (this.calls > 1) return Promise.reject(new Error("embedder down"));
    return this.inner.embedQuery(text, signal);
  }
  embedDocuments(texts: string[]) {
    return this.inner.embedDocuments(texts);
  }
}

async function setup(options: { embedder?: Embedder } = {}) {
  // The door reads the real clock for the open, so the receipts follow it plus an offset.
  let skew = 0;
  let n = 0;
  const receipts = new SearchReceipts({
    now: () => new Date(Date.now() + skew),
    token: () => `rcpt${++n}`,
  });
  const world = await oauthWorld({ receipts, ...options });
  const deps = createDeps(world.links, new FakeEmbedder(DIMS));
  const save = async (title: string) =>
    (await saveLink(deps, A, { url: `https://a.example/${title}`, savedBy: "seed", title })).link
      .id;
  const solar = await save("solar-panels");
  const roof = await save("solar-roof");
  const batteries = await save("batteries-guide");
  const browser = world.agent();
  await browser.signIn();
  return {
    world,
    browser,
    solar,
    roof,
    batteries,
    advance: (ms: number) => {
      skew += ms;
    },
  };
}

const receiptOf = (html: string) => /data-receipt="([^"]+)"/.exec(html)?.[1];
const ids = (html: string) => [...html.matchAll(/<li[^>]* data-id="(\d+)"/g)].map((m) => m[1]);
const logRows = (world: World) =>
  world.links
    .prepare(
      "SELECT owner_id AS owner, searched_by AS by, receipt, results, opened_link_id AS opened, created_at AS at FROM search_log ORDER BY id",
    )
    .all() as {
    owner: string;
    by: string;
    receipt: string | null;
    results: string;
    opened: number | null;
    at: number;
  }[];

describe("GET /search receipts", () => {
  it("gives a word search a receipt and writes no search_log row", async () => {
    const { world, browser } = await setup();
    const res = await browser.send("/search?q=solar");
    expect(res.status).toBe(200);
    expect(receiptOf(String(res.body))).toBe("rcpt1");
    expect(logRows(world)).toEqual([]);
  });

  it("the page reports the search and sends the receipt with a click; other pages do neither", async () => {
    const { browser } = await setup();
    const html = String((await browser.send("/search?q=solar")).body);
    expect(html).toContain('fetch("/search/log"');
    expect(html).toContain("JSON.stringify({ id: card.dataset.id, receipt })");
    for (const path of ["/all", "/search?q=solar&keep=1", "/search?q="]) {
      const other = String((await browser.send(path)).body);
      expect(other, path).not.toContain("/search/log");
      expect(other, path).not.toContain("receipt");
    }
  });

  it.each([
    ["keep mode", "/search?q=solar&keep=1"],
    ["a blank query", "/search?q="],
    ["a query with no word", "/search?q=%3F!"],
  ])("gives %s no receipt", async (_name, path) => {
    const { world, browser } = await setup();
    const res = await browser.send(path);
    expect(res.status).toBe(200);
    expect(receiptOf(String(res.body))).toBeUndefined();
    expect(logRows(world)).toEqual([]);
  });

  it.each([
    ["same-origin", true],
    ["none", true],
    ["cross-site", false],
    ["same-site", false],
  ])("Sec-Fetch-Site %s: receipt is %s", async (site, issued) => {
    const { browser } = await setup();
    const res = await browser.send("/search?q=solar", { headers: { "sec-fetch-site": site } });
    expect(receiptOf(String(res.body)) !== undefined).toBe(issued);
  });
});

describe("POST /search/log", () => {
  it("writes the entry the page showed, without searching again", async () => {
    const embedder = new OnceEmbedder();
    const { world, browser } = await setup({ embedder });
    const html = String((await browser.send("/search?q=solar")).body);
    const shown = ids(html);
    expect(shown.length).toBeGreaterThan(0);
    expect(embedder.calls).toBe(1);
    const res = await browser.send("/search/log", post({ receipt: receiptOf(html) }));
    expect(res.status).toBe(204);
    expect(embedder.calls).toBe(1);
    const rows = logRows(world);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner: A, by: "web", receipt: "rcpt1", opened: null });
    expect((JSON.parse(rows[0]?.results ?? "[]") as { id: string }[]).map((r) => r.id)).toEqual(
      shown,
    );
  });

  it("posting the same receipt twice leaves one row", async () => {
    const { world, browser } = await setup();
    const receipt = receiptOf(String((await browser.send("/search?q=solar")).body));
    expect((await browser.send("/search/log", post({ receipt }))).status).toBe(204);
    expect((await browser.send("/search/log", post({ receipt }))).status).toBe(204);
    expect(logRows(world)).toHaveLength(1);
  });

  it("an unknown receipt writes nothing", async () => {
    const { world, browser } = await setup();
    expect((await browser.send("/search/log", post({ receipt: "nope" }))).status).toBe(204);
    expect(logRows(world)).toEqual([]);
  });

  it("an expired receipt writes nothing", async () => {
    const { world, browser, advance } = await setup();
    const receipt = receiptOf(String((await browser.send("/search?q=solar")).body));
    advance(OPEN_WINDOW_MS + 1);
    expect((await browser.send("/search/log", post({ receipt }))).status).toBe(204);
    expect(logRows(world)).toEqual([]);
  });

  it("another owner's receipt writes nothing", async () => {
    const { world, browser } = await setup();
    const receipt = receiptOf(String((await browser.send("/search?q=solar")).body));
    const b = await addSecondUser(world);
    expect((await b.send("/search/log", post({ receipt }))).status).toBe(204);
    expect(logRows(world)).toEqual([]);
    expect((await browser.send("/search/log", post({ receipt }))).status).toBe(204);
    expect(logRows(world).map((r) => r.owner)).toEqual([A]);
  });

  it("refuses a body with no receipt", async () => {
    const { browser } = await setup();
    expect((await browser.send("/search/log", post({}))).status).toBe(400);
  });
});

describe("POST /links/opened with a receipt", () => {
  it("open first, then the log POST: one row, paired", async () => {
    const { world, browser, solar } = await setup();
    const receipt = receiptOf(String((await browser.send("/search?q=solar")).body));
    expect((await browser.send("/links/opened", post({ id: solar, receipt }))).status).toBe(204);
    expect(logRows(world).map((r) => r.opened)).toEqual([Number(solar)]);
    expect((await browser.send("/search/log", post({ receipt }))).status).toBe(204);
    expect(logRows(world).map((r) => r.opened)).toEqual([Number(solar)]);
    expect(
      world.links.prepare("SELECT last_opened_at AS t FROM links WHERE id = ?").get(Number(solar)),
    ).toEqual({ t: expect.any(Number) });
  });

  it("log POST first, then the open: paired", async () => {
    const { world, browser, solar } = await setup();
    const receipt = receiptOf(String((await browser.send("/search?q=solar")).body));
    await browser.send("/search/log", post({ receipt }));
    await browser.send("/links/opened", post({ id: solar, receipt }));
    expect(logRows(world).map((r) => r.opened)).toEqual([Number(solar)]);
  });

  it("an open without a receipt (All links) does not pair a logged search", async () => {
    const { world, browser, solar } = await setup();
    const receipt = receiptOf(String((await browser.send("/search?q=solar")).body));
    await browser.send("/search/log", post({ receipt }));
    expect((await browser.send("/links/opened", post({ id: solar }))).status).toBe(204);
    expect(logRows(world).map((r) => r.opened)).toEqual([null]);
  });

  it("a link that was not in the results does not pair, but is still recorded as opened", async () => {
    const { world, browser, batteries } = await setup();
    const html = String((await browser.send("/search?q=solar")).body);
    expect(ids(html)).not.toContain(batteries);
    const receipt = receiptOf(html);
    expect((await browser.send("/links/opened", post({ id: batteries, receipt }))).status).toBe(
      204,
    );
    expect(logRows(world).map((r) => r.opened)).toEqual([null]);
    expect(
      world.links
        .prepare("SELECT last_opened_at AS t FROM links WHERE id = ?")
        .get(Number(batteries)),
    ).toEqual({ t: expect.any(Number) });
  });

  it("a second open of the same search does not overwrite the first pair", async () => {
    const { world, browser, solar, roof } = await setup();
    const html = String((await browser.send("/search?q=solar")).body);
    expect(ids(html)).toEqual(expect.arrayContaining([solar, roof]));
    const receipt = receiptOf(html);
    await browser.send("/links/opened", post({ id: solar, receipt }));
    await browser.send("/links/opened", post({ id: roof, receipt }));
    expect(logRows(world).map((r) => r.opened)).toEqual([Number(solar)]);
  });

  it("an open outside the window does not pair", async () => {
    const { world, browser, solar } = await setup();
    const receipt = receiptOf(String((await browser.send("/search?q=solar")).body));
    await browser.send("/search/log", post({ receipt }));
    world.links
      .prepare("UPDATE search_log SET created_at = created_at - ?")
      .run(OPEN_WINDOW_MS + 1);
    await browser.send("/links/opened", post({ id: solar, receipt }));
    expect(logRows(world).map((r) => r.opened)).toEqual([null]);
  });

  it("another owner's, an expired and an unknown receipt neither pair nor write", async () => {
    const { world, browser, solar, advance } = await setup();
    const html = String((await browser.send("/search?q=solar")).body);
    const receipt = receiptOf(html);
    const b = await addSecondUser(world);
    // B opens A's link with A's receipt: B has no such link, so nothing is opened or paired.
    expect((await b.send("/links/opened", post({ id: solar, receipt }))).status).toBe(404);
    expect(logRows(world)).toEqual([]);
    expect((await browser.send("/links/opened", post({ id: solar, receipt: "nope" }))).status).toBe(
      204,
    );
    advance(OPEN_WINDOW_MS + 1);
    expect((await browser.send("/links/opened", post({ id: solar, receipt }))).status).toBe(204);
    expect(logRows(world)).toEqual([]);
  });

  it("a web row is not paired by another owner's open of a link with the same id in their results", async () => {
    const { world, browser, solar } = await setup();
    const receipt = receiptOf(String((await browser.send("/search?q=solar")).body));
    await browser.send("/search/log", post({ receipt }));
    const b = await addSecondUser(world);
    await b.send("/links/opened", post({ id: solar, receipt }));
    expect(logRows(world).map((r) => r.opened)).toEqual([null]);
  });
});
