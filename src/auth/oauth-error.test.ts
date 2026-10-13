import { describe, expect, it } from "vitest";
import { TEST_BASE_URL } from "./memory-auth.js";
import {
  authorizePath,
  DCR_REDIRECT,
  oauthWorld,
  otherClientDocument,
  pkce,
} from "./oauth-test-kit.js";

const FIXED = /<main>[\s\S]*<\/main>/;

/** The page's main text, for comparing two pages. */
const mainOf = (html: string) => FIXED.exec(html)?.[0] ?? "";

describe("the OAuth error page", () => {
  it("is served without a session, uncached, with our sentence for a known code", async () => {
    const world = await oauthWorld();
    const res = await world.agent().send("/oauth-error?error=invalid_client");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(String(res.body)).toContain("This app is not connected");
  });

  it.each([
    "Your_account_is_locked_call_18005550199",
    "it's-broken",
    "x".repeat(5000),
    "<img src=x onerror=alert(1)>",
    "constructor",
    "__proto__",
    "toString",
    "",
  ])(
    "shows only the generic sentence for error=%s, never the value or its description",
    async (code) => {
      const world = await oauthWorld();
      const generic = mainOf(String((await world.agent().send("/oauth-error")).body));
      const query = new URLSearchParams({
        error: code,
        error_description: "Call 1-800-555-0199 now",
      });
      const res = await world.agent().send(`/oauth-error?${query}`);
      expect(res.status).toBe(200);
      const html = String(res.body);
      expect(mainOf(html)).toBe(generic);
      expect(html).not.toContain("1-800");
      expect(html).not.toContain("function");
      if (code.length > 3) expect(html).not.toContain(code);
    },
  );

  it("never shows error_description, even with a known code", async () => {
    const world = await oauthWorld();
    const res = await world
      .agent()
      .send("/oauth-error?error=access_denied&error_description=Call%201-800-555-0199");
    const html = String(res.body);
    expect(html).toContain("not approved");
    expect(html).not.toContain("1-800");
  });
});

describe("authorize errors end on the error page", () => {
  const location = (res: { headers: Headers }) =>
    new URL(res.headers.get("location") ?? "", TEST_BASE_URL);

  it("sends a browser without a session to sign in, not to the error page", async () => {
    const world = await oauthWorld();
    const res = await world
      .agent()
      .send(authorizePath("unknown-dcr-1", DCR_REDIRECT, pkce().challenge));
    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe("/login");
  });

  it("sends the owner to the error page for an unknown DCR client", async () => {
    const world = await oauthWorld();
    const browser = world.agent();
    await browser.signIn();
    const res = await browser.send(authorizePath("unknown-dcr-1", DCR_REDIRECT, pkce().challenge));
    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe("/oauth-error");
    expect(location(res).searchParams.get("error")).toBe("invalid_client");
  });

  it("sends the owner to the error page for a CIMD client whose document does not load, which ends at HTML 200 without a session", async () => {
    const world = await oauthWorld();
    const x = otherClientDocument(5);
    world.net.status(x.id, 404);
    const browser = world.agent();
    await browser.signIn();
    const res = await browser.send(authorizePath(x.id, x.redirect, pkce().challenge));
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const to = location(res);
    expect(`${to.pathname}${to.search}`).toBe("/oauth-error?error=invalid_client");
    expect(world.stash.isCurrent(x.id)).toBe(false);

    const page = await world.agent().send(`${to.pathname}${to.search}`);
    expect(page.status).toBe(200);
    expect(String(page.body)).toContain("This app is not connected");
  });

  it("sends the owner to the error page for a CIMD client whose host answers 503, creating no consent or token", async () => {
    const world = await oauthWorld();
    const x = otherClientDocument(6);
    world.net.status(x.id, 503);
    const browser = world.agent();
    await browser.signIn();
    const res = await browser.send(authorizePath(x.id, x.redirect, pkce().challenge));
    expect(res.status).toBe(302);
    const to = location(res);
    expect(`${to.pathname}${to.search}`).toBe("/oauth-error?error=invalid_client");
    expect(world.stash.isCurrent(x.id)).toBe(false);
    expect(world.count("oauthConsent")).toBe(0);
    expect(world.count("oauthAccessToken")).toBe(0);
    expect(world.count("oauthRefreshToken")).toBe(0);
  });
});
