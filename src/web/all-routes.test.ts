import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { addSecondUser, oauthWorld, SECOND_USER, type World } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { LINK_ORDERS } from "../core/search.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const B = SECOND_USER.id;

let clock = Date.parse("2026-10-01T00:00:00Z");
const depsOf = (world: World) => ({
  ...createDeps(world.links, new FakeEmbedder(DIMS)),
  now: () => new Date(clock++),
});

async function save(world: World, owner: string, url: string, title = url) {
  const { link } = await saveLink(depsOf(world), owner, { url, title, savedBy: "seed" });
  return link.id;
}

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

describe("the All links routes", () => {
  it("lists the owner's untagged and tagged active links, uncached, and not another owner's", async () => {
    const world = await oauthWorld();
    await addSecondUser(world);
    await save(world, A, "https://a.example/plain", "Untagged link of A");
    await saveLink(depsOf(world), A, {
      url: "https://a.example/tagged",
      title: "Tagged link of A",
      savedBy: "seed",
      tags: [{ name: "Kitchen", source: "stated" }],
    });
    await save(world, B, "https://b.example/x", "Link of B");
    const res = await (await signedIn(world)).send("/all");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html(res)).toContain("Untagged link of A");
    expect(html(res)).toContain("Tagged link of A");
    expect(html(res)).not.toContain("Link of B");
  });

  it("shows an archived untagged link on /all/done and not on /all", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/active", "Still active");
    const done = await save(world, A, "https://a.example/done", "All done here");
    await depsOf(world).store.update(A, done, { state: "archived" });
    const browser = await signedIn(world);
    const active = html(await browser.send("/all"));
    const finished = await browser.send("/all/done");
    expect(active).toContain("Still active");
    expect(active).not.toContain("All done here");
    expect(finished.status).toBe(200);
    expect(html(finished)).toContain("All done here");
    expect(html(finished)).not.toContain("Still active");
  });

  it.each(LINK_ORDERS)(
    "walks 51 links in %s order with Show older links, 24 and 24 and 3",
    async (order) => {
      const world = await oauthWorld();
      const deps = depsOf(world);
      for (let i = 0; i < 51; i++) {
        const id = await save(world, A, `https://a.example/${i}`);
        const opened = (i * 7) % 51;
        await deps.store.update(A, id, {
          lastOpenedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, opened)),
        });
      }
      const browser = await signedIn(world);
      const pages: string[] = [];
      let next: string | undefined = order === "newest" ? "/all" : `/all?order=${order}`;
      while (next && pages.length < 5) {
        const sent = await browser.send(next);
        expect(sent.status, next).toBe(200);
        pages.push(html(sent));
        next = hrefsOf(html(sent), "#older")[0];
      }
      const counts = pages.map((p) => hrefsOf(p, ".link-card h3 a").length);
      expect(counts).toEqual([24, 24, 3]);
      const seen = pages.flatMap((p) => hrefsOf(p, ".link-card h3 a"));
      expect(new Set(seen).size).toBe(51);
      const first = { newest: 50, oldest: 0, opened: 29 }[order];
      expect(seen[0]).toBe(`https://a.example/${first}`);
    },
  );

  it("answers an unknown order and a changed cursor with a 400 that names where to start again", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/1");
    const browser = await signedIn(world);
    expect((await browser.send("/all?order=newest")).status).toBe(200);
    for (const path of [
      "/all?order=random",
      "/all/done?order=Newest",
      "/all?before=garbage",
      "/all?order=oldest&before=1.1",
      "/all/done?before=",
    ]) {
      const res = await browser.send(path);
      expect(res.status, path).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(hrefsOf(html(res), "main a"), path).toEqual(["/all"]);
    }
  });

  it("sends a browser without a session to /login, and refuses another site's Origin", async () => {
    const world = await oauthWorld();
    await save(world, A, "https://a.example/k");
    for (const path of ["/all", "/all/done", "/all?order=opened"]) {
      const anon = await world.agent().send(path);
      expect(anon.status).toBe(302);
      expect(anon.headers.get("location")).toBe("/login");
      const browser = await signedIn(world);
      const foreign = await browser.send(path, { headers: { origin: "https://evil.example" } });
      expect(foreign.status).toBe(403);
    }
  });
});
