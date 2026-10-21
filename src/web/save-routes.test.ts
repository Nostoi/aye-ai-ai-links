import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { AUTH_BODY_LIMIT } from "../auth/http.js";
import { TEST_BASE_URL } from "../auth/memory-auth.js";
import {
  type Agent,
  addSecondUser,
  allRows,
  oauthWorld,
  SECOND_USER,
  type World,
} from "../auth/oauth-test-kit.js";
import { saveLink, updateLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { bookmarkletCode } from "./bookmarklet.js";

const A = "owner";
const NEW = "https://news.example/story?id=1";
const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));
const saveAddress = (url: string, title: string) =>
  `/save?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`;
/** The page's text as shown, scripts left out (they name every state the page can reach). */
const shownText = (html: string) =>
  parseHTML(html.replace(/<script>[\s\S]*?<\/script>/g, "")).document.body.textContent ?? "";
const field = (html: string, id: string) =>
  parseHTML(html).document.getElementById(id)?.getAttribute("value");

async function signedIn() {
  const world = await oauthWorld();
  const browser = world.agent();
  await browser.signIn();
  return { world, browser };
}

describe("GET /save", () => {
  it("shows the form filled from its query, uncached and never framed, and writes nothing", async () => {
    const { world, browser } = await signedIn();
    const before = allRows(world);
    const res = await browser.send(saveAddress(NEW, "A story"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(field(String(res.body), "save-url")).toBe(NEW);
    expect(field(String(res.body), "save-title")).toBe("A story");
    expect(allRows(world)).toEqual(before);
  });

  it("for an address A already saved, still writes nothing and shows nothing of that link", async () => {
    const { world, browser } = await signedIn();
    await saveLink(linkDeps(world), A, { url: NEW, savedBy: "seed", title: "Saved before" });
    const before = allRows(world);
    const res = await browser.send(saveAddress(NEW, "A story"));
    expect(res.status).toBe(200);
    expect(shownText(String(res.body))).not.toContain("Already saved");
    expect(String(res.body)).not.toContain("Saved before");
    expect(allRows(world)).toEqual(before);
  });

  it("?long=1 shows the long-address message and no form", async () => {
    const { browser } = await signedIn();
    const res = await browser.send("/save?long=1");
    expect(res.status).toBe(200);
    expect(shownText(String(res.body))).toContain(
      "This page's address is too long to save from the bookmarklet.",
    );
    expect(parseHTML(String(res.body)).document.querySelector("form")).toBeNull();
  });

  it("leaves other pages without a framing header", async () => {
    const { browser } = await signedIn();
    for (const path of ["/", "/connections", "/search?q=x"]) {
      expect((await browser.send(path)).headers.get("content-security-policy"), path).toBeNull();
    }
  });

  it("refuses another site's Origin with 403 and writes nothing; a navigation with no Origin is served", async () => {
    const { world, browser } = await signedIn();
    const before = allRows(world);
    const foreign = await browser.send(saveAddress(NEW, "x"), {
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    expect((await browser.send(saveAddress(NEW, "x"), { origin: false })).status).toBe(200);
    expect(allRows(world)).toEqual(before);
  });

  it("without a session, sends the browser to sign in and back to this Save address", async () => {
    const world = await oauthWorld();
    const address = saveAddress("https://ex.com/a b+c", "Café + 😀");
    const res = await world.agent().send(address);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/login?next=")).toBe(true);
    expect(new URL(location, TEST_BASE_URL).searchParams.get("next")).toBe(address);
  });

  it("after signing in from there, the login page returns to the same Save page, filled", async () => {
    const world = await oauthWorld();
    const browser = world.agent();
    const url = "https://ex.com/a+b?q=c d&e=é";
    const title = "Café + 😀  two spaces";
    const first = await browser.send(saveAddress(url, title));
    const login = await browser.send(first.headers.get("location") ?? "");
    const next =
      parseHTML(String(login.body)).document.getElementById("login")?.getAttribute("data-next") ??
      "";
    expect(next.startsWith("/save?")).toBe(true);
    await browser.signIn();
    const before = allRows(world);
    const back = await browser.send(next);
    expect(back.status).toBe(200);
    expect(allRows(world)).toEqual(before);
    expect(field(String(back.body), "save-url")).toBe(url);
    expect(field(String(back.body), "save-title")).toBe(title);
  });

  it("a HEAD request keeps the framing and caching headers and writes nothing", async () => {
    const { world, browser } = await signedIn();
    const before = allRows(world);
    const res = await browser.send(saveAddress(NEW, "A story"), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(allRows(world)).toEqual(before);
  });

  it("the login page sends no Referer onward, so the return request stays small", async () => {
    const world = await oauthWorld();
    const res = await world.agent().send("/login?next=%2Fsave%3Furl%3Dhttps%253A%252F%252Fex.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("leaves every other page's sign-in redirect bare", async () => {
    const world = await oauthWorld();
    for (const path of ["/", "/search?q=x", "/connections"]) {
      const res = await world.agent().send(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe("/login");
    }
  });
});

const save = (browser: Agent, json: unknown, extra = {}) =>
  browser.send("/save", { method: "POST", json, ...extra });
const linkRow = (world: World, owner: string) =>
  world.links.prepare("SELECT * FROM links WHERE owner_id = ? ORDER BY id").all(owner) as Record<
    string,
    unknown
  >[];
const SAVED_2025 = new Date("2025-03-03T12:00:00Z");

describe("POST /save", () => {
  it("saves a new link for the signed-in owner, by web, with the why as asked: 200, uncached", async () => {
    const { world, browser } = await signedIn();
    const res = await save(browser, { url: NEW, title: "A story", why: "for the trip" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const [row] = linkRow(world, A);
    expect(row).toMatchObject({
      url: NEW,
      title: "A story",
      why_text: "for the trip",
      why_source: "asked",
      saved_by: "web",
      state: "active",
    });
    expect(res.body).toEqual({
      id: String(row?.id),
      created: true,
      whyKept: true,
      state: "active",
      savedAt: new Date(row?.saved_at as number).toISOString(),
      savedOn: expect.any(String),
      title: "A story",
      url: NEW,
      why: "for the trip",
      putAwayAt: null,
    });
  });

  it("a repeat save answers the link already saved, with its date, state and title, and keeps them", async () => {
    const { world, browser } = await signedIn();
    const deps = { ...linkDeps(world), now: () => SAVED_2025 };
    const { link } = await saveLink(deps, A, {
      url: NEW,
      savedBy: "claude",
      title: "Saved before",
    });
    await updateLink(linkDeps(world), A, link.id, { state: "archived" });
    const res = await save(browser, { url: NEW, title: "Ignored", why: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: link.id,
      created: false,
      whyKept: true,
      state: "archived",
      savedAt: "2025-03-03T12:00:00.000Z",
      savedOn: "March 3, 2025",
      title: "Saved before",
      url: NEW,
      why: null,
      putAwayAt: null,
    });
    expect(linkRow(world, A)).toMatchObject([
      { title: "Saved before", saved_by: "claude", state: "archived" },
    ]);
  });

  it("a repeat save of a put-away link answers its put-away date, as ISO", async () => {
    const { world, browser } = await signedIn();
    const { link } = await saveLink(linkDeps(world), A, { url: NEW, savedBy: "claude" });
    const at = new Date("2026-10-01T08:00:00.123Z");
    await linkDeps(world).store.update(A, link.id, { state: "archived", putAwayAt: at });
    const res = await save(browser, { url: NEW, title: null, why: null });
    expect(res.body).toMatchObject({ state: "archived", putAwayAt: at.toISOString() });
  });

  it("over a stated why, keeps it and answers whyKept false with the stored why", async () => {
    const { world, browser } = await signedIn();
    await saveLink(linkDeps(world), A, {
      url: NEW,
      savedBy: "claude",
      why: { text: "theirs", source: "stated" },
    });
    const res = await save(browser, { url: NEW, title: null, why: "mine" });
    expect(res.body).toMatchObject({ created: false, whyKept: false, why: "theirs" });
    expect(linkRow(world, A)).toMatchObject([{ why_text: "theirs", why_source: "stated" }]);
  });

  it("over an agent's guess, replaces it with the owner's why", async () => {
    const { world, browser } = await signedIn();
    await saveLink(linkDeps(world), A, {
      url: NEW,
      savedBy: "claude",
      why: { text: "guess", source: "inferred" },
    });
    const res = await save(browser, { url: NEW, title: null, why: "mine" });
    expect(res.body).toMatchObject({ created: false, whyKept: true, why: "mine" });
    expect(linkRow(world, A)).toMatchObject([{ why_text: "mine", why_source: "asked" }]);
  });

  it("acts for the signed-in owner only: B saving A's address gets its own new link, and A's link is unchanged", async () => {
    const { world, browser } = await signedIn();
    await saveLink(linkDeps(world), A, {
      url: NEW,
      savedBy: "claude",
      title: "A's story",
      why: { text: "A's reason", source: "stated" },
    });
    const bBrowser = await addSecondUser(world);
    const before = linkRow(world, A);
    const res = await save(bBrowser, { url: NEW, title: "B title", why: "B reason" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      created: true,
      whyKept: true,
      title: "B title",
      why: "B reason",
    });
    expect(JSON.stringify(res.body)).not.toContain("A's");
    expect(linkRow(world, A)).toEqual(before);
    expect(linkRow(world, SECOND_USER.id)).toMatchObject([
      { url: NEW, saved_by: "web", why_source: "asked" },
    ]);
    // The same request from A is a repeat save, so B's new link is down to whose session it is.
    expect(
      ((await save(browser, { url: NEW, title: null, why: null })).body as { created: boolean })
        .created,
    ).toBe(false);
  });

  it.each([
    [
      "an ftp address",
      "ftp://ex.com/a",
      "Only http and https links can be saved, not ftp:. Use the page's web address.",
    ],
    [
      "an address with a password",
      "https://u:pw@ex.com/a",
      "The URL contains a username or password. Remove the credentials and save the plain address.",
    ],
  ])("refuses %s with 400 in core's words, and writes nothing", async (_, url, message) => {
    const { world, browser } = await signedIn();
    const before = allRows(world);
    const res = await save(browser, { url, title: null, why: null });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: "invalid_url", message });
    expect(allRows(world)).toEqual(before);
  });

  it("refuses a title of 201 characters with 400 in core's words, and writes nothing", async () => {
    const { world, browser } = await signedIn();
    const before = allRows(world);
    const res = await save(browser, { url: NEW, title: "a".repeat(201), why: null });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: "invalid_input",
      message: "A title can be at most 200 characters.",
    });
    expect(allRows(world)).toEqual(before);
  });

  it.each([
    ["no title member", { url: NEW, why: null }],
    ["a why that is a number", { url: NEW, title: null, why: 3 }],
    ["a url that is null", { url: null, title: null, why: null }],
  ])("refuses a body with %s with 400, and writes nothing", async (_, json) => {
    const { world, browser } = await signedIn();
    const before = allRows(world);
    const res = await save(browser, json);
    expect(res.status).toBe(400);
    expect((res.body as { code?: unknown }).code).toBe("BAD_REQUEST");
    expect(allRows(world)).toEqual(before);
  });

  it("refuses a body over 16 KiB with 413, and writes nothing", async () => {
    const { world, browser } = await signedIn();
    const before = allRows(world);
    const res = await save(browser, { url: NEW, title: null, why: "x".repeat(AUTH_BODY_LIMIT) });
    expect(res.status).toBe(413);
    expect(allRows(world)).toEqual(before);
  });

  it.each([
    ["without an Origin", { origin: false }],
    ["with a foreign Origin", { headers: { origin: "https://evil.example" } }],
  ])("refuses a request %s with 403, and writes nothing", async (_, extra) => {
    const { world, browser } = await signedIn();
    const before = allRows(world);
    expect((await save(browser, { url: NEW, title: null, why: null }, extra)).status).toBe(403);
    expect(allRows(world)).toEqual(before);
    // The same request with the site's Origin saves, so the 403 is down to the Origin.
    expect((await save(browser, { url: NEW, title: null, why: null })).status).toBe(200);
  });

  it("without a session sends the browser to a bare /login, and writes nothing", async () => {
    const world = await oauthWorld();
    const before = allRows(world);
    const res = await save(world.agent(), { url: NEW, title: null, why: null });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(allRows(world)).toEqual(before);
  });
});

describe("the install section on Apps and keys", () => {
  it("builds the bookmarklet from the configured origin, not the request's", async () => {
    const { browser } = await signedIn();
    // An http request to the same host: a page built from the request would name http://.
    const res = await browser.send("http://links.example/connections");
    expect(res.status).toBe(200);
    const href = parseHTML(String(res.body))
      .document.getElementById("bookmarklet")
      ?.getAttribute("href");
    expect(href).toBe(bookmarkletCode(TEST_BASE_URL));
    expect(href).toContain('"https://links.example"');
  });
});
