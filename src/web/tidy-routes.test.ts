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
import { keepHandy } from "../core/tools.js";
import { WORTH_SIZE } from "../core/worth-a-look.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const DAY = 86_400_000;
/** Old links Home offers as Tidy up's session once Worth a look has taken its picks. */
const SESSION = 5;
const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));
const post = (json: unknown) => ({ method: "POST", json });

/** An old link of `owner`: saved 60 days ago (older for a lower `n`) and never opened, so Tidy up offers it. */
async function oldLink(
  world: World,
  n: number,
  owner = A,
  tags: { name: string; source: "stated" }[] = [],
) {
  const { link } = await saveLink(linkDeps(world), owner, {
    url: `https://${owner}.example/old-${n}`,
    savedBy: "seed",
    title: `Old link ${n} of ${owner}`,
    tags,
  });
  world.links
    .prepare("UPDATE links SET saved_at = ? WHERE id = ?")
    .run(Date.now() - (60 + 100 - n) * DAY, Number(link.id));
  return link.id;
}

/** `count` old links of A's and A's signed-in browser. Worth a look takes WORTH_SIZE of them. */
async function tidy(count = 1) {
  const world = await oauthWorld();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(await oldLink(world, i));
  const browser = world.agent();
  await browser.signIn();
  return { world, browser, ids };
}

const stepIds = (html: string) =>
  [...html.matchAll(/<div class="tidy-step" data-id="(\d+)"/g)].map((m) => m[1] as string);
const homeHtml = async (browser: Awaited<ReturnType<typeof tidy>>["browser"]) =>
  String((await browser.send("/")).body);
const outsideTidy = (html: string) =>
  html.replace(/<section class="tidy-tray"[\s\S]*?<\/section>/, "");

describe("GET /tidy", () => {
  it("sends the old page's address to Home, uncached, showing no link", async () => {
    const { browser } = await tidy(WORTH_SIZE + SESSION);
    const res = await browser.send("/tidy");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(String(res.body)).not.toContain("Old link");
  });

  it("refuses another site's Origin or Host with 403", async () => {
    const { browser } = await tidy(1);
    const foreign: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { host: "evil.example" },
    ];
    for (const headers of foreign) {
      expect((await browser.send("/tidy", { headers })).status).toBe(403);
    }
    expect((await browser.send("/tidy", { origin: false })).status).toBe(303);
  });
});

describe("GET / Tidy up tray", () => {
  it("is offered closed at five old links Home shows nowhere else, its steps hidden and no link to /tidy", async () => {
    const { browser, ids } = await tidy(WORTH_SIZE + SESSION);
    const res = await browser.send("/");
    expect(res.status).toBe(200);
    const html = String(res.body);
    expect(html).toContain("Clear out a few links?");
    expect(html).not.toContain('href="/tidy"');
    const steps = stepIds(html);
    expect(steps).toHaveLength(SESSION);
    expect(steps.every((id) => ids.includes(id))).toBe(true);
    expect(html.match(/<div class="tidy-step" data-id="\d+" hidden>/g)).toHaveLength(SESSION);
    // Nothing on Home appears twice: no tray link is a card, row or tile above it.
    const elsewhere = [...outsideTidy(html).matchAll(/data-id="(\d+)"/g)].map((m) => m[1]);
    expect(elsewhere.length).toBeGreaterThan(0);
    for (const id of steps) expect(elsewhere).not.toContain(id);
  });

  it("offers what is left when fewer than five are, with no minimum (#340)", async () => {
    const { browser } = await tidy(WORTH_SIZE + SESSION - 1);
    const html = await homeHtml(browser);
    expect(html).toContain(">Explore</h2>");
    expect(html).toContain("Clear out a few links?");
    expect(stepIds(html)).toHaveLength(SESSION - 1);
  });

  it("says '1 link to look at.' for one (#347)", async () => {
    const { browser } = await tidy(WORTH_SIZE + 1);
    expect(await homeHtml(browser)).toContain("1 link to look at. One at a time.");
  });

  it("counts the session's links, not every link that qualifies (#347)", async () => {
    const { browser } = await tidy(WORTH_SIZE + SESSION + 3);
    expect(await homeHtml(browser)).toContain(`${SESSION} links to look at. One at a time.`);
  });

  it("is still the last tray, with nothing to ask and no Start, when Explore takes every old link (#347)", async () => {
    const { browser } = await tidy(WORTH_SIZE);
    const html = await homeHtml(browser);
    expect(html).toContain('<section class="tidy-tray"');
    expect(html).toContain("Nothing to tidy right now.");
    expect(html).not.toContain("Clear out a few links?");
    expect(html).not.toContain("data-tidy=");
    expect(html).not.toContain("tidy-step");
  });

  it("still offers a link that is a space card's recent link: only Explore's cards and Handy are skipped (#340)", async () => {
    const world = await oauthWorld();
    for (let i = 0; i < WORTH_SIZE + SESSION; i++) {
      await oldLink(world, i, A, [{ name: "Kitchen", source: "stated" }]);
    }
    await linkDeps(world).store.pinTag(A, "kitchen", { pinned: true, color: "clay" });
    const browser = world.agent();
    await browser.signIn();
    const html = await homeHtml(browser);
    const steps = stepIds(html);
    expect(html).toContain("home-space-recent");
    expect(steps).toHaveLength(SESSION);
    const spaces = html.slice(html.indexOf('<section class="spaces"'));
    const recent = spaces.slice(0, spaces.indexOf("</section>"));
    expect(
      steps.some((id) => recent.includes(`/links/${id}`) || recent.includes(`data-id="${id}"`)),
    ).toBe(true);
  });

  it("leaves out a link Home suggests for the Handy shelf", async () => {
    const world = await oauthWorld();
    const ids: string[] = [];
    for (let i = 0; i < WORTH_SIZE + SESSION + 1; i++) ids.push(await oldLink(world, i));
    const suggested = ids[0] as string;
    await keepHandy(linkDeps(world), A, suggested, "inferred");
    const browser = world.agent();
    await browser.signIn();
    const html = await homeHtml(browser);
    const steps = stepIds(html);
    expect(steps).toHaveLength(SESSION);
    expect(steps).not.toContain(suggested);
  });

  it("says a link fits a current focus the keyword search finds", async () => {
    const { world, browser } = await tidy(WORTH_SIZE + SESSION);
    await addProfile(linkDeps(world), A, "Claude", {
      addFocus: [{ text: "old", source: "inferred" }],
    });
    const html = await homeHtml(browser);
    expect(html).toMatch(/Might fit <b>old<\/b>, which you may be working on \(a guess\)\./);
  });

  it("shows no fit line when the owner has no current focus", async () => {
    const { browser } = await tidy(WORTH_SIZE + SESSION);
    const html = await homeHtml(browser);
    expect(html).toContain("tidy-step");
    expect(html).not.toContain("Might fit");
    expect(html).not.toContain("Doesn't fit anything");
  });

  it("reading Home twice leaves every row byte-identical", async () => {
    const { world, browser } = await tidy(WORTH_SIZE + SESSION);
    await homeHtml(browser);
    const before = allRows(world);
    expect((await browser.send("/")).status).toBe(200);
    expect(allRows(world)).toEqual(before);
  });

  it("a second owner's Home has their own tray and none of the first owner's links", async () => {
    const { world } = await tidy(WORTH_SIZE + SESSION);
    const b = await addSecondUser(world);
    for (let i = 0; i < WORTH_SIZE + SESSION; i++) await oldLink(world, i, SECOND_USER.id);
    const html = String((await b.send("/")).body);
    expect(stepIds(html)).toHaveLength(SESSION);
    expect(html).toContain(`of ${SECOND_USER.id}`);
    expect(html).not.toMatch(new RegExp(`of ${A}(?!-)`));
  });
});

describe("Keep in Tidy up is Keep it (#339)", () => {
  it("POST /tidy/keep is gone: a 404, changing nothing", async () => {
    const { world, browser, ids } = await tidy(1);
    const before = allRows(world);
    expect((await browser.send("/tidy/keep", post({ id: ids[0] }))).status).toBe(404);
    expect(allRows(world)).toEqual(before);
  });

  it("a link kept with /home/keep is out of the next session, and its Undo brings it back", async () => {
    const { browser } = await tidy(WORTH_SIZE + SESSION + 1);
    const [kept, ...left] = stepIds(await homeHtml(browser));
    expect(left).toHaveLength(SESSION - 1);
    const res = await browser.send("/home/keep", post({ id: kept }));
    expect(res.status).toBe(200);
    const steps = stepIds(await homeHtml(browser));
    expect(steps).toHaveLength(SESSION);
    expect(steps).not.toContain(kept);
    await browser.send("/home/undo-intent", post({ id: kept, change: res.body }));
    expect(stepIds(await homeHtml(browser))).toContain(kept);
  });

  it("answers 404 for a link that does not exist, and 400 for a body without an id", async () => {
    const { world, browser } = await tidy(1);
    const before = allRows(world);
    expect((await browser.send("/home/keep", post({ id: "999999" }))).status).toBe(404);
    expect((await browser.send("/home/keep", post({}))).status).toBe(400);
    expect(allRows(world)).toEqual(before);
  });
});
