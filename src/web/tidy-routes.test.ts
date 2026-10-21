import { describe, expect, it } from "vitest";
import {
  addSecondUser,
  allRows,
  oauthWorld,
  SECOND_USER,
  type World,
} from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { addProfile } from "../core/profile.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const DAY = 86_400_000;
const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));
const post = (json: unknown) => ({ method: "POST", json });
const row = (world: World, id: string) =>
  world.links.prepare("SELECT * FROM links WHERE id = ?").get(Number(id)) as Record<
    string,
    unknown
  >;

/** An old link of `owner`: saved 60 days ago and never opened, so Tidy up offers it. */
async function oldLink(world: World, n: number, owner = A) {
  const { link } = await saveLink(linkDeps(world), owner, {
    url: `https://${owner}.example/old-${n}`,
    savedBy: "seed",
    title: `Old link ${n} of ${owner}`,
  });
  world.links
    .prepare("UPDATE links SET saved_at = ? WHERE id = ?")
    .run(Date.now() - 60 * DAY, Number(link.id));
  return link.id;
}

async function tidy(count = 1) {
  const world = await oauthWorld();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(await oldLink(world, i));
  const browser = world.agent();
  await browser.signIn();
  return { world, browser, ids };
}

describe("GET /tidy", () => {
  it("shows the owner's old links as a session, the first one visible, uncached", async () => {
    const { browser, ids } = await tidy(6);
    const res = await browser.send("/tidy");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = String(res.body);
    for (const id of ids.slice(0, 5))
      expect(html).toContain(`<section class="tidy-step" data-id="${id}"`);
    expect(html).not.toContain(`data-id="${ids[5]}"`);
    expect(html).toContain("Link 1 of 5");
    expect(html).toContain("Keep");
  });

  it("an owner with nothing old gets the finish screen alone", async () => {
    const world = await oauthWorld();
    const browser = world.agent();
    await browser.signIn();
    const html = String((await browser.send("/tidy")).body);
    expect(html).toContain("Done for now.");
    expect(html).not.toContain("data-id=");
  });

  it("says a link fits a current focus the keyword search finds", async () => {
    const world = await oauthWorld();
    await oldLink(world, 1);
    await addProfile(linkDeps(world), A, "Claude", {
      addFocus: [{ text: "old", source: "inferred" }],
    });
    const browser = world.agent();
    await browser.signIn();
    const html = String((await browser.send("/tidy")).body);
    expect(html).toMatch(/Might fit <b>old<\/b>, which you may be working on \(a guess\)\./);
  });

  it("shows no fit line when the owner has no current focus", async () => {
    const { browser } = await tidy(1);
    const html = String((await browser.send("/tidy")).body);
    expect(html).not.toContain("Might fit");
    expect(html).not.toContain("Doesn't fit anything");
  });

  it("refuses another site's Origin or Host with 403, showing no link", async () => {
    const { browser } = await tidy(1);
    const foreign: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { host: "evil.example" },
    ];
    for (const headers of foreign) {
      const res = await browser.send("/tidy", { headers });
      expect(res.status).toBe(403);
      expect(String(res.body)).not.toContain("Old link");
    }
    expect((await browser.send("/tidy", { origin: false })).status).toBe(200);
  });

  it("twice leaves every row byte-identical", async () => {
    const { world, browser } = await tidy(2);
    const before = allRows(world);
    expect((await browser.send("/tidy")).status).toBe(200);
    expect((await browser.send("/tidy")).status).toBe(200);
    expect(allRows(world)).toEqual(before);
  });

  it("a second owner sees none of the first owner's links", async () => {
    const { world } = await tidy(2);
    const b = await addSecondUser(world);
    await oldLink(world, 9, SECOND_USER.id);
    const html = String((await b.send("/tidy")).body);
    expect(html).toContain(`of ${SECOND_USER.id}`);
    expect(html).not.toMatch(new RegExp(`of ${A}(?!-)`));
  });
});

describe("POST /tidy/keep", () => {
  it("sets the keep date and answers 204, uncached, changing nothing else", async () => {
    const { world, browser, ids } = await tidy(1);
    const id = ids[0] as string;
    const before = row(world, id);
    const res = await browser.send("/tidy/keep", post({ id }));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const after = row(world, id);
    expect(after.tidy_kept_at).toEqual(expect.any(Number));
    expect({ ...after, tidy_kept_at: null }).toEqual({ ...before, tidy_kept_at: null });
  });

  it("a kept link is out of the next session", async () => {
    const { browser, ids } = await tidy(2);
    await browser.send("/tidy/keep", post({ id: ids[0] }));
    const html = String((await browser.send("/tidy")).body);
    expect(html).not.toContain(`data-id="${ids[0]}"`);
    expect(html).toContain(`data-id="${ids[1]}"`);
  });

  it("refuses a link that is no longer active with 409, writing nothing", async () => {
    const { world, browser, ids } = await tidy(1);
    const id = ids[0] as string;
    world.links.prepare("UPDATE links SET state = 'archived' WHERE id = ?").run(Number(id));
    const before = allRows(world);
    const res = await browser.send("/tidy/keep", post({ id }));
    expect(res.status).toBe(409);
    expect(allRows(world)).toEqual(before);
    expect(row(world, id).tidy_kept_at).toBeNull();
  });

  it("answers 404 for a link that does not exist, and 400 for a body without an id", async () => {
    const { browser } = await tidy(1);
    expect((await browser.send("/tidy/keep", post({ id: "999999" }))).status).toBe(404);
    expect((await browser.send("/tidy/keep", post({}))).status).toBe(400);
  });

  it("refuses another site's Origin with 403, writing nothing", async () => {
    const { world, browser, ids } = await tidy(1);
    const res = await browser.send("/tidy/keep", {
      ...post({ id: ids[0] }),
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(row(world, ids[0] as string).tidy_kept_at).toBeNull();
  });

  it("the two-owner test of POST /tidy/keep: B cannot keep A's link, and A's tidyKeptAt stays null", async () => {
    const { world, ids } = await tidy(1);
    const id = ids[0] as string;
    const b = await addSecondUser(world);
    const before = allRows(world);
    const res = await b.send("/tidy/keep", post({ id }));
    expect(res.status).toBe(404);
    expect(row(world, id).tidy_kept_at).toBeNull();
    expect(allRows(world)).toEqual(before);
  });
});
