import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { addSecondUser, oauthWorld, SECOND_USER, type World } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { setTagColor, setTagPinned } from "../core/tag-space.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

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
    for (const before of ["garbage", "1.999999", ""]) {
      const res = await browser.send(`${path}?tag=kitchen&before=${encodeURIComponent(before)}`);
      expect(res.status, before).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
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
    const links = [first, html(second)].flatMap((p) => hrefsOf(p, ".link-card h3 a"));
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
    const a = await signedIn(world);
    const asA = html(await a.send("/spaces?tag=kitchen"));
    const asB = html(await b.send("/spaces?tag=kitchen"));
    expect(asA).toContain("Kitchen link of A");
    expect(asA).not.toContain("Kitchen link of B");
    expect(asA).toMatch(/class="band space-clay"/);
    expect(asB).toContain("Kitchen link of B");
    expect(asB).not.toContain("Kitchen link of A");
    expect(asB).toMatch(/class="band space-violet"/);
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
    expect(home).not.toContain("Baking");
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

describe("the search page's spaces", () => {
  it("names each result's space from the owner's catalog", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/q", ["Kitchen"], "Quokka kitchen");
    await setTagPinned(depsOf(world), A, { name: "Kitchen", pinned: true });
    const page = html(await (await signedIn(world)).send("/search?q=quokka"));
    const result = parseHTML(page).document.querySelector(".result");
    expect(result?.className).toMatch(/space-[a-z]+/);
    expect(result?.querySelector(".in-space")?.textContent?.trim()).toBe("Kitchen");
  });
});
