import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { TEST_BASE_URL } from "../auth/memory-auth.js";
import { allRows, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

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
