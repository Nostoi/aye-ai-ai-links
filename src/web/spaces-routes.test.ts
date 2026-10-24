import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { addSecondUser, oauthWorld, SECOND_USER, type World } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { mergeTags, renameTag } from "../core/tag-edit.js";
import { setTagColor, setTagPinned } from "../core/tag-space.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS, MODEL_KEY } from "../search/model.js";

const A = "owner";
const B = SECOND_USER.id;
const ODD_NAME = "C++ & Ü/x#y";
const HOSTILE = "<img src=x onerror=alert(1)>";

let clock = 1_000;
const depsOf = (world: World) => ({
  ...createDeps(world.links, new FakeEmbedder(DIMS)),
  now: () => new Date(clock++),
});

async function save(world: World, owner: string, url: string, tags: string[], title = url) {
  const { link } = await saveLink(depsOf(world), owner, {
    url,
    title,
    savedBy: "seed",
    tags: tags.map((name) => ({ name, source: "stated" as const })),
  });
  return link.id;
}

const archive = (world: World, owner: string, id: string) =>
  depsOf(world).store.update(owner, id, { state: "archived" });

async function signedIn(world: World) {
  const browser = world.agent();
  await browser.signIn();
  return browser;
}

const html = (sent: { body: unknown }) => String(sent.body);
const hrefsOf = (page: string, selector: string) =>
  [...parseHTML(page).document.querySelectorAll(selector)].map(
    (a) => a.getAttribute("href") as string,
  );

describe("a space page", () => {
  it("shows the owner's active links in the space, uncached, and not the done ones", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/active", ["Kitchen"], "Quartz counters");
    const done = await save(world, A, "https://a.example/done", ["Kitchen"], "Old sink");
    await save(world, A, "https://a.example/other", ["Garden"], "Tomatoes");
    await archive(world, A, done);
    const res = await (await signedIn(world)).send("/spaces?tag=kitchen");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html(res)).toContain("Quartz counters");
    expect(html(res)).not.toContain("Old sink");
    expect(html(res)).not.toContain("Tomatoes");
  });

  it("shows the done links, and only those, in the space's done view", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/active", ["Kitchen"], "Quartz counters");
    const done = await save(world, A, "https://a.example/done", ["Kitchen"], "Old sink");
    await archive(world, A, done);
    const res = await (await signedIn(world)).send("/spaces/done?tag=Kitchen");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html(res)).toContain("Old sink");
    expect(html(res)).not.toContain("Quartz counters");
  });

  it.each(["/spaces", "/spaces/done"])(
    "sends %s with a missing, empty or blank tag home with a 303",
    async (path) => {
      const browser = await signedIn(await oauthWorld());
      for (const query of ["", "?tag=", "?tag=%20%20", "?before=1.1"]) {
        const res = await browser.send(`${path}${query}`);
        expect(res.status, `${path}${query}`).toBe(303);
        expect(res.headers.get("location")).toBe("/");
      }
    },
  );

  it.each(["/spaces", "/spaces/done"])(
    "answers %s for an unknown tag and another owner's tag with the same 404, never naming it",
    async (path) => {
      const world = await oauthWorld();
      await addSecondUser(world);
      await save(world, B, "https://b.example/pantry", ["Pantrysecret"], "Pantry link of B");
      const browser = await signedIn(world);
      const unknown = await browser.send(`${path}?tag=gardensecret`);
      const foreign = await browser.send(`${path}?tag=pantrysecret`);
      expect(unknown.status).toBe(404);
      expect(foreign.status).toBe(404);
      expect(foreign.headers.get("cache-control")).toBe("no-store");
      expect(html(unknown).replace("gardensecret", "pantrysecret")).toBe(html(foreign));
      expect(html(unknown)).not.toContain("gardensecret");
      expect(html(foreign)).not.toMatch(/pantrysecret|Pantry link of B/i);
    },
  );

  it.each(["/spaces", "/spaces/done"])("refuses a bad cursor on %s with a 400", async (path) => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/one", ["Kitchen"]);
    const browser = await signedIn(world);
    for (const before of ["garbage", ""]) {
      const res = await browser.send(`${path}?tag=kitchen&before=${encodeURIComponent(before)}`);
      expect(res.status, before).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it.each(["/spaces", "/spaces/done"])(
    "restarts %s at its first page when the cursor names no live link",
    async (path) => {
      const world = await oauthWorld();
      await save(world, A, "https://a.example/one", ["Kitchen"]);
      const browser = await signedIn(world);
      const res = await browser.send(`${path}?tag=kitchen&before=1.999999`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${path}?tag=kitchen`);
    },
  );

  it("a stale cursor on a tag the owner lacks redirects, then the first page is 404", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/one", ["Kitchen"]);
    const browser = await signedIn(world);
    const stale = await browser.send("/spaces?tag=pantry&before=1.999999");
    expect(stale.status).toBe(303);
    expect(stale.headers.get("location")).toBe("/spaces?tag=pantry");
    expect((await browser.send("/spaces?tag=pantry")).status).toBe(404);
  });

  it("pages through a space with the Show older links href", async () => {
    const world = await oauthWorld();
    for (let i = 0; i < 25; i++) await save(world, A, `https://a.example/${i}`, ["Kitchen"]);
    const browser = await signedIn(world);
    const first = html(await browser.send("/spaces?tag=kitchen"));
    const [older] = hrefsOf(first, "#older");
    expect(older).toBeDefined();
    const second = await browser.send(older as string);
    expect(second.status).toBe(200);
    const links = [first, html(second)].flatMap((p) => hrefsOf(p, ".link-row h3 a"));
    expect(new Set(links).size).toBe(25);
    expect(hrefsOf(html(second), "#older")).toEqual([]);
  });

  it("gives each owner only their own space when both have a tag with the same key", async () => {
    const world = await oauthWorld();
    const b = await addSecondUser(world);
    await save(world, A, "https://a.example/k", ["Kitchen"], "Kitchen link of A");
    await save(world, B, "https://b.example/k", ["kitchen"], "Kitchen link of B");
    await setTagColor(depsOf(world), A, { name: "kitchen", color: "clay" });
    await setTagColor(depsOf(world), B, { name: "kitchen", color: "violet" });
    await setTagPinned(depsOf(world), A, { name: "kitchen", pinned: true });
    await setTagPinned(depsOf(world), B, { name: "kitchen", pinned: true });
    const a = await signedIn(world);
    const asA = html(await a.send("/spaces?tag=kitchen"));
    const asB = html(await b.send("/spaces?tag=kitchen"));
    expect(asA).toContain("Kitchen link of A");
    expect(asA).not.toContain("Kitchen link of B");
    expect(asA).toMatch(/class="page-head space-clay"/);
    expect(asB).toContain("Kitchen link of B");
    expect(asB).not.toContain("Kitchen link of A");
    expect(asB).toMatch(/class="page-head space-violet"/);
  });

  it("colors the header dot only while the tag is pinned, keeping its color while unpinned", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/k", ["Kitchen"]);
    await setTagColor(depsOf(world), A, { name: "kitchen", color: "clay" });
    const browser = await signedIn(world);
    const header = async () =>
      parseHTML(html(await browser.send("/spaces?tag=kitchen"))).document.querySelector(
        "header.page-head",
      )?.className;
    expect(await header()).toBe("page-head");
    await setTagPinned(depsOf(world), A, { name: "kitchen", pinned: true });
    expect(await header()).toBe("page-head space-clay");
    await setTagPinned(depsOf(world), A, { name: "kitchen", pinned: false });
    expect(await header()).toBe("page-head");
  });

  it("sends a browser without a session to /login, and refuses another site's Origin", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/k", ["Kitchen"]);
    for (const path of ["/spaces?tag=kitchen", "/spaces/done?tag=kitchen"]) {
      const anon = await world.agent().send(path);
      expect(anon.status).toBe(302);
      expect(anon.headers.get("location")).toBe("/login");
      const browser = await signedIn(world);
      const foreign = await browser.send(path, { headers: { origin: "https://evil.example" } });
      expect(foreign.status).toBe(403);
    }
  });
});

describe("a space page's sort orders", () => {
  const titlesOf = (page: string) =>
    [...parseHTML(page).document.querySelectorAll(".link-row h3")].map((h) =>
      h.textContent?.trim(),
    );

  async function seeded() {
    const world = await oauthWorld();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(await save(world, A, `https://a.example/${i}`, ["Kitchen"], `Link ${i}`));
    }
    await save(world, A, "https://a.example/other", ["Garden"], "Garden link");
    return { world, ids, browser: await signedIn(world) };
  }

  it("lists the space oldest first and pages on in the same order", async () => {
    const { browser } = await seeded();
    const first = html(await browser.send("/spaces?tag=kitchen&order=oldest"));
    expect(titlesOf(first)[0]).toBe("Link 0");
    expect(titlesOf(first)).toHaveLength(24);
    const [older] = hrefsOf(first, "#older");
    expect(older).toContain("order=oldest");
    const second = await browser.send(older as string);
    expect(second.status).toBe(200);
    expect(titlesOf(html(second))).toEqual(["Link 24"]);
    expect(html(second)).not.toContain("Garden link");
  });

  it("lists only the opened links of the space by recent opening", async () => {
    const { world, ids, browser } = await seeded();
    const deps = depsOf(world);
    await deps.store.update(A, ids[3] as string, { lastOpenedAt: new Date(5_000_000) });
    await deps.store.update(A, ids[7] as string, { lastOpenedAt: new Date(9_000_000) });
    const page = html(await browser.send("/spaces?tag=kitchen&order=opened"));
    expect(titlesOf(page)).toEqual(["Link 7", "Link 3"]);
    const none = html(await browser.send("/spaces?tag=garden&order=opened"));
    expect(none).toContain("Nothing in this space opened yet.");
  });

  it("answers an unknown order or another order's cursor with the 400 restart page", async () => {
    const { browser } = await seeded();
    const oldest = html(await browser.send("/spaces?tag=kitchen&order=oldest"));
    const [older] = hrefsOf(oldest, "#older");
    const cursor = new URL(older as string, "https://x.example").searchParams.get("before");
    for (const path of [
      "/spaces?tag=kitchen&order=random",
      `/spaces/done?tag=kitchen&before=${encodeURIComponent(cursor as string)}`,
      `/spaces?tag=kitchen&before=${encodeURIComponent(cursor as string)}`,
      `/spaces?tag=kitchen&order=opened&before=${encodeURIComponent(cursor as string)}`,
    ]) {
      const res = await browser.send(path);
      expect(res.status, path).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("restarts a cursor naming no live link at the first page of the same order", async () => {
    const { browser } = await seeded();
    const res = await browser.send("/spaces?tag=kitchen&order=oldest&before=o1.999999");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/spaces?tag=kitchen&order=oldest");
  });

  it("gives Out of your lists no sort: it reads no order and lists newest first", async () => {
    const world = await oauthWorld();
    const first = await save(world, A, "https://a.example/1", ["Kitchen"], "Old one");
    const second = await save(world, A, "https://a.example/2", ["Kitchen"], "New one");
    for (const id of [first, second]) await archive(world, A, id);
    const browser = await signedIn(world);
    const plain = await browser.send("/spaces/done?tag=kitchen");
    const asked = await browser.send("/spaces/done?tag=kitchen&order=oldest");
    expect(titlesOf(html(plain))).toEqual(["New one", "Old one"]);
    expect(titlesOf(html(asked))).toEqual(["New one", "Old one"]);
    expect(parseHTML(html(asked)).document.querySelector("nav.orders")).toBeNull();
  });

  it("sends the Out of your lists address with no order, whatever the order of the space", async () => {
    const { browser } = await seeded();
    const page = html(await browser.send("/spaces?tag=kitchen&order=oldest"));
    expect(hrefsOf(page, "a.done-link")).toEqual(["/spaces/done?tag=kitchen"]);
  });
});

describe("Your spaces on the home page", () => {
  it("shows the owner's pinned tags only, each opening its space, and a quiet line with none", async () => {
    const world = await oauthWorld();
    const b = await addSecondUser(world);
    await save(world, A, "https://a.example/k", ["Kitchen", "Baking"]);
    await save(world, B, "https://b.example/k", ["Bsecretspace"]);
    await setTagPinned(depsOf(world), B, { name: "Bsecretspace", pinned: true });
    const a = await signedIn(world);
    expect(html(await a.send("/"))).toContain("Pin a tag on the");
    await setTagPinned(depsOf(world), A, { name: "Kitchen", pinned: true });
    const home = html(await a.send("/"));
    expect(hrefsOf(home, "a.home-space")).toEqual(["/spaces?tag=kitchen"]);
    // A card's edit data (data-tags) names all of its own link's tags; no other place on Home does.
    expect(home.replace(/ data-tags="[^"]*"/g, "")).not.toContain("Baking");
    expect(home).not.toContain("Bsecretspace");
    expect(html(await b.send("/"))).not.toContain("Kitchen");
  });

  it("round-trips an odd tag name through the rendered href, from home and from the Tags page", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/odd", [ODD_NAME], "The odd link");
    await setTagPinned(depsOf(world), A, { name: ODD_NAME, pinned: true });
    const browser = await signedIn(world);
    const fromHome = hrefsOf(html(await browser.send("/")), "a.home-space");
    const fromTags = hrefsOf(html(await browser.send("/tags")), "a.tag-name");
    expect(fromHome).toHaveLength(1);
    expect(fromTags).toEqual(fromHome);
    const res = await browser.send(fromHome[0] as string);
    expect(res.status).toBe(200);
    expect(html(res)).toContain("The odd link");
    expect(html(res)).toContain("C++ &amp; Ü/x#y");
  });

  it("keeps a hostile tag name inert on home and on its space page", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/h", [HOSTILE]);
    await setTagPinned(depsOf(world), A, { name: HOSTILE, pinned: true });
    const browser = await signedIn(world);
    const home = html(await browser.send("/"));
    const [href] = hrefsOf(home, "a.home-space");
    const space = html(await browser.send(href as string));
    for (const page of [home, space]) {
      expect(page).not.toContain("<img src=x");
      expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }
  });
});

describe("Search this space", () => {
  const resultTitles = (page: string) =>
    [...parseHTML(page).document.querySelectorAll(".result h2")].map((h) => h.textContent?.trim());
  const embedder = new FakeEmbedder(DIMS);

  /** Gives a link a stored meaning vector for `text`, so a search for exactly that finds it. */
  async function embed(world: World, owner: string, id: string, text: string) {
    await depsOf(world).vectorIndex.writeVector(
      owner,
      id,
      MODEL_KEY,
      `hash:${text}`,
      await embedder.embedQuery(text),
      new Date(0),
    );
  }

  async function seeded() {
    const world = await oauthWorld();
    const inside = await save(world, A, "https://a.example/in", ["Kitchen"], "Quartz counters");
    const outside = await save(world, A, "https://a.example/out", ["Garden"], "Quartz sample");
    return { world, inside, outside, browser: await signedIn(world) };
  }

  it("finds words in the space only, and everywhere without the tag", async () => {
    const { browser } = await seeded();
    expect(resultTitles(html(await browser.send("/search?q=quartz&tag=Kitchen")))).toEqual([
      "Quartz counters",
    ]);
    expect(resultTitles(html(await browser.send("/search?q=quartz"))).sort()).toEqual([
      "Quartz counters",
      "Quartz sample",
    ]);
  });

  it("leaves out a link outside the space that matches only by its page text", async () => {
    const { world, outside, browser } = await seeded();
    const { changes } = world.links
      .prepare("UPDATE snapshots SET text = ? WHERE link_id = ?")
      .run("a long page about zebrafish tanks", Number(outside));
    expect(changes).toBe(1);
    expect(resultTitles(html(await browser.send("/search?q=zebrafish")))).toEqual([
      "Quartz sample",
    ]);
    const within = html(await browser.send("/search?q=zebrafish&tag=kitchen"));
    expect(resultTitles(within)).toEqual([]);
    expect(within).not.toContain("Quartz sample");
  });

  it("leaves out a link outside the space that matches only by meaning", async () => {
    const { world, outside, browser } = await seeded();
    await embed(world, A, outside, "something unrelated to any word");
    const everywhere = html(
      await browser.send("/search?q=something%20unrelated%20to%20any%20word"),
    );
    expect(resultTitles(everywhere)).toContain("Quartz sample");
    const within = html(
      await browser.send("/search?q=something%20unrelated%20to%20any%20word&tag=kitchen"),
    );
    expect(resultTitles(within)).not.toContain("Quartz sample");
  });

  it("lists the space's newest links for a blank search, named by space, and finds out-of-list links too", async () => {
    const { world, inside, browser } = await seeded();
    const done = await save(world, A, "https://a.example/done", ["Kitchen"], "Old sink");
    await archive(world, A, done);
    const page = html(await browser.send("/search?q=&tag=kitchen"));
    expect(resultTitles(page)).toEqual(["Old sink", "Quartz counters"]);
    expect(page).not.toContain("Quartz sample");
    expect(inside).toBeDefined();
    const heading = parseHTML(page).document.querySelector("h1");
    expect(heading?.textContent?.replace(/\s+/g, " ").trim()).toBe("Your newest links in Kitchen");
  });

  it("names the space in the heading of a word search too, in its color", async () => {
    const { world, browser } = await seeded();
    await setTagColor(depsOf(world), A, { name: "Kitchen", color: "clay" });
    await setTagPinned(depsOf(world), A, { name: "Kitchen", pinned: true });
    const d = parseHTML(html(await browser.send("/search?q=quartz&tag=kitchen"))).document;
    expect(d.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Best matches first in Kitchen",
    );
    expect(d.querySelector("h1 .dot")).not.toBeNull();
    expect(d.querySelector("h1 .in-space")?.className).toContain("space-clay");
  });

  it("colors each result by the searched space when a link is in two", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/two", ["Garden", "Kitchen"], "Quartz twice");
    for (const [name, color] of [
      ["Garden", "violet"],
      ["Kitchen", "clay"],
    ] as const) {
      await setTagColor(depsOf(world), A, { name, color });
      await setTagPinned(depsOf(world), A, { name, pinned: true });
    }
    const browser = await signedIn(world);
    const classOf = async (path: string) =>
      parseHTML(html(await browser.send(path))).document.querySelector(".result")?.className;
    expect(await classOf("/search?q=quartz")).toContain("space-violet");
    expect(await classOf("/search?q=quartz&tag=kitchen")).toContain("space-clay");
  });

  it("says nothing in the space matched, with a link that runs the same words everywhere", async () => {
    const { browser } = await seeded();
    for (const keep of ["", "&keep=1"]) {
      const page = html(await browser.send(`/search?q=nonexistentword&tag=kitchen${keep}`));
      const d = parseHTML(page).document;
      const body = d.querySelector("main")?.textContent?.replace(/\s+/g, " ");
      expect(body).toContain("Nothing in Kitchen matched.");
      expect(hrefsOf(page, "a.search-all")).toEqual([`/search?q=nonexistentword${keep}`]);
    }
  });

  it("carries the tag and keep through the form and the Not it? links", async () => {
    const { browser } = await seeded();
    const page = html(await browser.send("/search?q=quartz&tag=kitchen&keep=1"));
    const d = parseHTML(page).document;
    const hidden = Object.fromEntries(
      [...d.querySelectorAll("form.search-page input[type=hidden]")].map((i) => [
        i.getAttribute("name"),
        i.getAttribute("value"),
      ]),
    );
    expect(hidden).toEqual({ keep: "1", tag: "kitchen" });
    expect(hrefsOf(page, ".not-it a")).toEqual([
      "/search?q=&tag=kitchen&keep=1",
      "/search?q=quartz&keep=1",
    ]);
  });

  it("carries a key with odd characters through the form and the links", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/odd", [ODD_NAME], "Odd one");
    const browser = await signedIn(world);
    const key = encodeURIComponent("c++ & ü/x#y");
    const page = html(await browser.send(`/search?q=odd&tag=${key}`));
    expect(resultTitles(page)).toEqual(["Odd one"]);
    const d = parseHTML(page).document;
    expect(d.querySelector("form.search-page input[name=tag]")?.getAttribute("value")).toBe(
      "c++ & ü/x#y",
    );
    expect(hrefsOf(page, ".not-it a")[0]).toBe(`/search?q=&tag=${key}`);
  });

  it("treats a blank tag as no tag and gives an unknown or another owner's tag the same 404", async () => {
    const world = await oauthWorld();
    await addSecondUser(world);
    await save(world, A, "https://a.example/mine", ["Kitchen"], "Quartz mine");
    await save(world, B, "https://b.example/theirs", ["Pantrysecret"], "Quartz theirs");
    const browser = await signedIn(world);
    for (const tag of ["", "%20%20"]) {
      const res = await browser.send(`/search?q=quartz&tag=${tag}`);
      expect(res.status, tag).toBe(200);
      expect(resultTitles(html(res))).toEqual(["Quartz mine"]);
    }
    const unknown = await browser.send("/search?q=quartz&tag=gardensecret");
    const foreign = await browser.send("/search?q=quartz&tag=pantrysecret");
    expect([unknown.status, foreign.status]).toEqual([404, 404]);
    expect(foreign.headers.get("cache-control")).toBe("no-store");
    expect(html(unknown).replace("gardensecret", "pantrysecret")).toBe(html(foreign));
    expect(html(foreign)).not.toMatch(/pantrysecret|Quartz theirs|Quartz mine/i);
  });
});

describe("the search page's spaces", () => {
  it("names each result's space from the owner's catalog", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/q", ["Kitchen"], "Quokka kitchen");
    await setTagPinned(depsOf(world), A, { name: "Kitchen", pinned: true });
    const page = html(await (await signedIn(world)).send("/search?q=quokka"));
    const result = parseHTML(page).document.querySelector(".result");
    expect(result?.className).toMatch(/space-[a-z]+/);
    expect(result?.querySelector(".card-line .line-space")?.textContent?.trim()).toBe("Kitchen");
  });
});

describe("the List / Pictures choice on All links and space pages", () => {
  const ROUTES = ["/all", "/all/done", "/spaces?tag=Kitchen", "/spaces/done?tag=Kitchen"];
  const viewOn = async (browser: Awaited<ReturnType<typeof signedIn>>, path: string) =>
    parseHTML(html(await browser.send(path)))
      .document.querySelector("main")
      ?.getAttribute("data-view");

  it("draws each page in the view this browser's cookie names, and the list without one", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/q", ["Kitchen"], "Quokka kitchen");
    const browser = await signedIn(world);
    for (const path of ROUTES) expect(await viewOn(browser, path), path).toBe("list");
    browser.cookies.set("aye_view", "pictures");
    for (const path of ROUTES) expect(await viewOn(browser, path), path).toBe("pictures");
    for (const junk of ["list", "PICTURES", "pictures%20", "grid"]) {
      browser.cookies.set("aye_view", junk);
      expect(await viewOn(browser, "/all"), junk).toBe("list");
    }
  });

  it("answers Show older links in the same view, so the rows it appends match", async () => {
    const world = await oauthWorld();
    for (let i = 0; i < 25; i++) await save(world, A, `https://a.example/${i}`, ["Kitchen"]);
    const browser = await signedIn(world);
    browser.cookies.set("aye_view", "pictures");
    const first = html(await browser.send("/spaces?tag=Kitchen"));
    const older = parseHTML(first).document.getElementById("older")?.getAttribute("href");
    expect(older).toContain("before=");
    expect(await viewOn(browser, older as string)).toBe("pictures");
  });
});

describe("old tag addresses", () => {
  async function renamed() {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/one", ["pixel-art"], "Sprite sheet");
    await renameTag(depsOf(world), A, { name: "pixel-art", newName: "pixel art" });
    return { world, browser: await signedIn(world) };
  }

  it.each(["/spaces", "/spaces/done"])(
    "%s redirects the old address of a renamed tag, keeping order and before",
    async (path) => {
      const { browser } = await renamed();
      const plain = await browser.send(`${path}?tag=pixel-art`);
      expect(plain.status).toBe(303);
      expect(plain.headers.get("location")).toBe(`${path}?tag=pixel+art`);
      const kept = await browser.send(`${path}?tag=pixel-art&order=opened&before=o1.5`);
      expect(kept.headers.get("location")).toBe(`${path}?tag=pixel+art&order=opened&before=o1.5`);
      expect((await browser.send(`${path}?tag=pixel%20art`)).status).toBe(200);
    },
  );

  it("redirects a merged-away tag's address to the kept tag", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/one", ["game art"]);
    await save(world, A, "https://a.example/two", ["game assets"]);
    await mergeTags(depsOf(world), A, { name: "game assets", into: "game art" });
    const res = await (await signedIn(world)).send("/spaces?tag=game%20assets");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/spaces?tag=game+art");
  });

  it("answers 404 to owner B for owner A's old address, and A's aliases stay", async () => {
    const { world } = await renamed();
    const bBrowser = await addSecondUser(world);
    const rows = () => world.links.prepare("SELECT * FROM tag_aliases ORDER BY old_key").all();
    const before = rows();
    for (const path of [
      "/spaces?tag=pixel-art",
      "/spaces/done?tag=pixel-art",
      "/search?q=x&tag=pixel-art",
    ]) {
      const res = await bBrowser.send(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("location"), path).toBeNull();
    }
    expect(rows()).toEqual(before);
  });

  it("redirects an old search address, keeping every other parameter", async () => {
    const { browser } = await renamed();
    const res = await browser.send("/search?q=sprites&keep=1&tag=pixel-art");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/search?q=sprites&keep=1&tag=pixel+art");
    expect((await browser.send("/search?q=sprites&keep=1&tag=pixel%20art")).status).toBe(200);
  });

  it("recovers a live tag's purged cursor as before, with no redirect to itself", async () => {
    const { browser } = await renamed();
    const res = await browser.send("/spaces?tag=pixel%20art&before=1.999999");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/spaces?tag=pixel%20art");
    expect((await browser.send("/spaces?tag=pixel%20art")).status).toBe(200);
  });

  it("a live tag wins over an old address with the same key", async () => {
    const { world, browser } = await renamed();
    await save(world, A, "https://a.example/two", ["pixel-art"], "Fresh pixel-art");
    const res = await browser.send("/spaces?tag=pixel-art");
    expect(res.status).toBe(200);
    expect(html(res)).toContain("Fresh pixel-art");
  });
});
