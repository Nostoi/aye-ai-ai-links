import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { scriptedModel } from "../ai/model-test-kit.js";
import { addSecondUser, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import type { LinkSearch } from "../core/search.js";
import { SearchReceipts } from "../core/search-receipts.js";
import { renameTag } from "../core/tag-edit.js";
import { setTagColor, setTagPinned } from "../core/tag-space.js";
import { createDeps } from "../deps.js";
import { type Embedder, FakeEmbedder } from "../search/embedder.js";
import type { FtsSearch } from "../search/fts-search.js";
import { HybridSearch } from "../search/hybrid-search.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const post = (json: unknown) => ({ method: "POST", json });

const depsOf = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));
const receiptOf = (html: string) => /data-receipt="([^"]+)"/.exec(html)?.[1];
const idsOf = (html: string) =>
  [...parseHTML(html).document.querySelectorAll("li[data-id]")].map((li) =>
    li.getAttribute("data-id"),
  );
const logRows = (world: World) =>
  world.links
    .prepare("SELECT receipt, opened_link_id AS opened FROM search_log ORDER BY id")
    .all() as { receipt: string | null; opened: number | null }[];

async function save(
  world: World,
  title: string,
  extra: { tags?: string[]; why?: { text: string; source: "stated" | "inferred" } } = {},
  owner = A,
) {
  const { link } = await saveLink(depsOf(world), owner, {
    url: `https://a.example/${title.replaceAll(" ", "-")}`,
    savedBy: "seed",
    title,
    ...(extra.why && { why: extra.why }),
    ...(extra.tags && { tags: extra.tags.map((name) => ({ name, source: "stated" as const })) }),
  });
  return link.id;
}

async function signedIn(world: World) {
  const browser = world.agent();
  await browser.signIn();
  return browser;
}

/** Hands out `rcpt1`, `rcpt2`, ... so a test can name the receipt it expects. */
const receipts = () => {
  let n = 0;
  return new SearchReceipts({ token: () => `rcpt${++n}` });
};

describe("GET /search/quick", () => {
  it("shows the first five of the links /search shows, in the same order", async () => {
    // The search reads to three times its limit, so asking for 5 and asking for 20 rank apart: the
    // link at the page's rank 17 is beyond a depth of 15 (limit 5) but within 60 (limit 20).
    const limits: number[] = [];
    let fixture: { ids: string[] } | undefined;
    const search: LinkSearch = {
      search: (owner, query, filters, limit, trace) => {
        limits.push(limit);
        return new HybridSearch(
          keyword(fixture?.ids ?? []),
          vectors(fixture?.ids ?? []),
          embedder,
          "k",
          () => {},
        ).search(owner, query, filters, limit, trace);
      },
    };
    const world = await oauthWorld({ search });
    const ids: string[] = [];
    for (let n = 1; n <= 20; n++) ids.push(await save(world, `Panel guide ${n}`));
    fixture = { ids };
    const browser = await signedIn(world);

    const quick = String((await browser.send("/search/quick?q=panel")).body);
    expect(limits).toEqual([20]);
    const page = String((await browser.send("/search?q=panel")).body);
    expect(limits).toEqual([20, 20]);
    const top = (html: string) => idsOf(html).slice(0, 5);
    expect(idsOf(quick)).toHaveLength(5);
    expect(idsOf(quick)).toEqual(top(page));
    // Asked for 5, the same search ranks the links another way.
    const five = await new HybridSearch(keyword(ids), vectors(ids), embedder, "k", () => {}).search(
      A,
      "panel",
      {},
      5,
    );
    expect(five).not.toEqual(idsOf(quick));
  });

  it("answers an empty fragment for a blank query, without searching", async () => {
    let searched = 0;
    const world = await oauthWorld({
      search: {
        search: async () => {
          searched++;
          return [];
        },
      },
    });
    const browser = await signedIn(world);
    for (const path of ["/search/quick", "/search/quick?q=", "/search/quick?q=%20%20"]) {
      const res = await browser.send(path);
      expect(res.status, path).toBe(200);
      expect(String(res.body), path).toBe("");
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
    expect(searched).toBe(0);
  });

  it("shows at most five rows with a See all link carrying the words and no count", async () => {
    const world = await oauthWorld();
    for (let n = 1; n <= 8; n++) await save(world, `Solar roof ${n}`);
    const browser = await signedIn(world);
    const html = String((await browser.send("/search/quick?q=solar%20roof")).body);
    expect(idsOf(html)).toHaveLength(5);
    const all = parseHTML(html).document.querySelector("a.find-all");
    expect(all?.getAttribute("href")).toBe("/search?q=solar%20roof");
    expect(all?.textContent).toBe("See all results");
    expect(all?.textContent).not.toMatch(/\d/);
  });

  it("draws each row as a combobox option: title, why with its guess label, space and site", async () => {
    const world = await oauthWorld();
    const deps = depsOf(world);
    const stated = await save(world, "Solar plan", {
      tags: ["House"],
      why: { text: "for the roof quote", source: "stated" },
    });
    await save(world, "Solar roof", { why: { text: "maybe the garage", source: "inferred" } });
    await setTagColor(deps, A, { name: "House", color: "clay" });
    await setTagPinned(deps, A, { name: "House", pinned: true });
    const browser = await signedIn(world);
    const { document } = parseHTML(String((await browser.send("/search/quick?q=solar")).body));
    expect(document.querySelector("ol")?.getAttribute("role")).toBe("listbox");
    const options = [...document.querySelectorAll('a[role="option"]')];
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(options.map((o) => o.getAttribute("id"))).toEqual(["find-opt-0", "find-opt-1"]);
    const planned = options.find((o) => o.closest("li")?.getAttribute("data-id") === stated);
    expect(planned?.querySelector(".find-title")?.textContent).toBe("Solar plan");
    expect(planned?.querySelector(".find-why")?.textContent).toBe("for the roof quote");
    expect(planned?.querySelector(".line-space")?.textContent).toBe("House");
    expect(planned?.getAttribute("href")).toBe("https://a.example/Solar-plan");
    expect(planned?.hasAttribute("data-open")).toBe(true);
    const guess = options.find((o) => o !== planned);
    expect(guess?.querySelector(".find-why")?.textContent).toBe("Why (a guess): maybe the garage");
  });

  it("limits a search to a space, leaves that space out of the rows, and carries it to See all", async () => {
    const world = await oauthWorld();
    const inside = await save(world, "Solar tiles", { tags: ["House"] });
    await save(world, "Solar cells", { tags: ["Garden"] });
    await setTagColor(depsOf(world), A, { name: "House", color: "clay" });
    await setTagPinned(depsOf(world), A, { name: "House", pinned: true });
    const browser = await signedIn(world);
    const html = String((await browser.send("/search/quick?q=solar&tag=house")).body);
    expect(idsOf(html)).toEqual([inside]);
    expect(html).not.toContain('class="line-space');
    expect(parseHTML(html).document.querySelector("a.find-all")?.getAttribute("href")).toBe(
      "/search?q=solar&tag=house",
    );
  });

  it("reads a renamed space's old address as the space it became, and 404s a missing one", async () => {
    const world = await oauthWorld();
    const inside = await save(world, "Solar tiles", { tags: ["Kitchen"] });
    await save(world, "Solar cells", { tags: ["Garden"] });
    await renameTag(depsOf(world), A, { name: "Kitchen", newName: "Scullery" });
    const browser = await signedIn(world);
    const old = await browser.send("/search/quick?q=solar&tag=kitchen");
    expect(old.status).toBe(200);
    expect(idsOf(String(old.body))).toEqual([inside]);
    expect(
      parseHTML(String(old.body)).document.querySelector("a.find-all")?.getAttribute("href"),
    ).toBe("/search?q=solar&tag=scullery");
    const missing = await browser.send("/search/quick?q=solar&tag=nowhere");
    expect(missing.status).toBe(404);
    expect(String(missing.body)).not.toContain("nowhere");
  });

  it("says nothing matched, with no See all, and offers Ask AI only when the AI is on", async () => {
    const world = await oauthWorld();
    await save(world, "Solar roof");
    const browser = await signedIn(world);
    const html = String((await browser.send("/search/quick?q=zzqxv")).body);
    expect(html).toContain("Nothing matched.");
    expect(html).toContain("Try different words");
    expect(html).not.toContain("find-all");
    expect(html).not.toContain("data-ask-text");
  });

  it("gives a word search a receipt and writes no search_log row itself", async () => {
    const world = await oauthWorld({ receipts: receipts() });
    await save(world, "Solar roof");
    const browser = await signedIn(world);
    const res = await browser.send("/search/quick?q=solar");
    expect(receiptOf(String(res.body))).toBe("rcpt1");
    expect(logRows(world)).toEqual([]);
  });

  it.each([
    ["same-origin", true],
    ["none", true],
    ["cross-site", false],
    ["same-site", false],
  ])("Sec-Fetch-Site %s: receipt is %s, as for /search", async (site, issued) => {
    const world = await oauthWorld({ receipts: receipts() });
    await save(world, "Solar roof");
    const browser = await signedIn(world);
    const res = await browser.send("/search/quick?q=solar", {
      headers: { "sec-fetch-site": site },
    });
    expect(receiptOf(String(res.body)) !== undefined).toBe(issued);
  });

  it("gives a query with no word and a nothing-matched search the same receipt rule as /search", async () => {
    const world = await oauthWorld({ receipts: receipts() });
    await save(world, "Solar roof");
    const browser = await signedIn(world);
    // A word nothing matches still ran a search, so it has a receipt; a query with no word did not.
    expect(receiptOf(String((await browser.send("/search/quick?q=zzqxv")).body))).toBe("rcpt1");
    expect(receiptOf(String((await browser.send("/search/quick?q=%3F!")).body))).toBeUndefined();
  });

  it("logs a quick find and the results page that follows it as two rows, and pairs an open with its own search", async () => {
    const world = await oauthWorld({ receipts: receipts() });
    const solar = await save(world, "Solar roof");
    const browser = await signedIn(world);
    const quick = receiptOf(String((await browser.send("/search/quick?q=solar")).body));
    const full = receiptOf(String((await browser.send("/search?q=solar")).body));
    expect([quick, full]).toEqual(["rcpt1", "rcpt2"]);
    expect((await browser.send("/search/log", post({ receipt: quick }))).status).toBe(204);
    expect((await browser.send("/search/log", post({ receipt: full }))).status).toBe(204);
    expect((await browser.send("/links/opened", post({ id: solar, receipt: quick }))).status).toBe(
      204,
    );
    expect(logRows(world)).toEqual([
      { receipt: "rcpt1", opened: Number(solar) },
      { receipt: "rcpt2", opened: null },
    ]);
  });

  it("refuses a request that names another site as its origin", async () => {
    const world = await oauthWorld();
    await save(world, "Solar roof");
    const browser = await signedIn(world);
    const res = await browser.send("/search/quick?q=solar", {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("shows another owner's search none of the first owner's links", async () => {
    const world = await oauthWorld();
    await save(world, "Solar roof");
    const other = await addSecondUser(world);
    expect(String((await other.send("/search/quick?q=solar")).body)).toContain("Nothing matched.");
  });
});

/** The keyword side of the ranking fixture: link ids by index, as the page and the meaning rank them. */
const PAGE_RANK = [8, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 1];
const MEANING_RANK = [1];

const keyword = (ids: string[]): Pick<FtsSearch, "search" | "parts"> => ({
  search: async () => [],
  parts: (_owner, _query, _filters, limit, depth) => ({
    fields: [] as string[],
    pageOnly: PAGE_RANK.map((i) => ids[i] as string).slice(0, depth),
  }),
});

const vectors = (ids: string[]) => ({
  nearest: (_owner: string, _vector: Float32Array, _filters: object, k: number) =>
    MEANING_RANK.map((i) => ({ id: ids[i] as string, similarity: 0.5 })).slice(0, k),
});

const embedder: Embedder = {
  embedQuery: async () => new Float32Array([1, 0]),
  embedDocuments: async () => [],
};

describe("GET /search/quick offers Ask AI", () => {
  const nothing = async (world: World, extra: string) => {
    await save(world, "Solar roof");
    const browser = await signedIn(world);
    return String((await browser.send(`/search/quick?q=zzqxv${extra}`)).body);
  };

  it("when the AI is on and the dialog says its page has the panel", async () => {
    const world = await oauthWorld({ ai: scriptedModel("Fake", []) });
    expect(await nothing(world, "&assist=1")).toContain("data-ask-text");
  });

  it("not without the flag, even with the AI on", async () => {
    const world = await oauthWorld({ ai: scriptedModel("Fake", []) });
    expect(await nothing(world, "")).not.toContain("data-ask-text");
  });

  it("not with the AI off, flag or not", async () => {
    const world = await oauthWorld();
    expect(await nothing(world, "&assist=1")).not.toContain("data-ask-text");
  });
});
