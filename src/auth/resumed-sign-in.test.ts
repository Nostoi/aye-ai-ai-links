import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_BASE_URL, TEST_EMAIL, TEST_PASSWORD } from "./memory-auth.js";
import {
  type Agent,
  authorizePath,
  CLAUDE_ID,
  CLAUDE_REDIRECT,
  connectClaude,
  oauthWorld,
  pkce,
  type World,
} from "./oauth-test-kit.js";

const GENERIC = "The connection could not be completed. Start it again from the app.";

afterEach(() => {
  vi.useRealTimers();
});

/** A connected Claude sends a signed-out browser to authorize; returns the login page's signed query. */
async function loginQuery(world: World, browser: Agent) {
  await connectClaude(world);
  const az = await browser.send(authorizePath(CLAUDE_ID, CLAUDE_REDIRECT, pkce().challenge));
  const login = new URL(az.headers.get("location") ?? "", TEST_BASE_URL);
  expect(login.pathname).toBe("/login");
  expect(login.searchParams.has("sig")).toBe(true);
  return login.search.slice(1);
}

const withdraw = async (world: World) => {
  world.net.status(CLAUDE_ID, 404);
  await world.refresher.cycle();
};

const signInForm = (browser: Agent, oauthQuery: string, password = TEST_PASSWORD) =>
  browser.send("/api/auth/sign-in/email", {
    method: "POST",
    form: { email: TEST_EMAIL, password, oauth_query: oauthQuery },
  });

const signInJson = (browser: Agent, oauthQuery: string, password = TEST_PASSWORD) =>
  browser.signIn({ password, oauth_query: oauthQuery });

/** better-auth reads a repeated form field's last value, so an empty first one still resumes. */
const signInRepeatedForm = (browser: Agent, oauthQuery: string, password = TEST_PASSWORD) =>
  browser.send("/api/auth/sign-in/email", {
    method: "POST",
    rawForm: `${new URLSearchParams({ email: TEST_EMAIL, password, oauth_query: "" })}&${new URLSearchParams({ oauth_query: oauthQuery })}`,
  });

describe("a sign-in that resumes an authorize", () => {
  it.each([
    ["JSON", signInJson],
    ["a form", signInForm],
    ["a form whose oauth_query is repeated, the first empty", signInRepeatedForm],
  ])(
    "sent as %s, for a client whose document was withdrawn, goes to the error page signed in, with no code or token",
    async (_, signIn) => {
      const world = await oauthWorld();
      const browser = world.agent();
      const oauthQuery = await loginQuery(world, browser);
      await withdraw(world);
      const before = {
        codes: world.count("verification"),
        tokens: world.count("oauthAccessToken"),
        sessions: world.count("session"),
      };

      const resumed = await signIn(browser, oauthQuery);
      expect(resumed.status).toBe(200);
      expect(resumed.body).toEqual({ redirect: true, url: "/oauth-error?error=invalid_client" });
      expect(resumed.headers.getSetCookie()).toHaveLength(1);
      expect(world.count("session")).toBe(before.sessions + 1);
      expect((await browser.send("/api/auth/get-session")).body).not.toBeNull();
      const page = await browser.send("/oauth-error?error=invalid_client");
      expect(page.bytes.toString()).toContain("This app is not connected");
      expect(world.count("verification")).toBe(before.codes);
      expect(world.count("oauthAccessToken")).toBe(before.tokens);
    },
  );

  it.each([
    ["JSON", signInJson],
    ["a form", signInForm],
  ])("sent as %s with a wrong password stays a 401 and signs nobody in", async (_, signIn) => {
    const world = await oauthWorld();
    const oauthQuery = await loginQuery(world, world.agent());
    await withdraw(world);
    const sessions = world.count("session");
    const stranger = world.agent();
    const wrong = await signIn(stranger, oauthQuery, "Wrong-horse-battery-1");
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    expect(wrong.headers.getSetCookie()).toEqual([]);
    expect(world.count("session")).toBe(sessions);
  });

  it("with a query past its expiry goes to the error page's generic sentence, signing nobody in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const world = await oauthWorld();
    const browser = world.agent();
    const oauthQuery = await loginQuery(world, browser);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const sessions = world.count("session");

    const resumed = await signInJson(browser, oauthQuery);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toEqual({ redirect: true, url: "/oauth-error?error=invalid_signature" });
    expect(resumed.headers.getSetCookie()).toEqual([]);
    expect(world.count("session")).toBe(sessions);
    const page = await browser.send("/oauth-error?error=invalid_signature");
    expect(page.bytes.toString()).toContain(GENERIC);
    expect(page.bytes.toString()).not.toContain("invalid_signature");
  });

  it("for a current client still returns to the app with a code, its state and the issuer", async () => {
    const world = await oauthWorld();
    const browser = world.agent();
    const oauthQuery = await loginQuery(world, browser);
    const resumed = await signInJson(browser, oauthQuery);
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ redirect: true });
    const back = new URL(String((resumed.body as { url: unknown }).url));
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_REDIRECT);
    expect(back.searchParams.get("code")).toBeTruthy();
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("iss")).toBe(`${TEST_BASE_URL}/api/auth`);
    expect(resumed.headers.getSetCookie()).toHaveLength(1);
  });

  it("is logged with the refusal's code and never its description", async () => {
    const lines: string[] = [];
    const world = await oauthWorld({ log: (line) => lines.push(line) });
    const browser = world.agent();
    const oauthQuery = await loginQuery(world, browser);
    await withdraw(world);
    lines.length = 0;
    await signInJson(browser, oauthQuery);
    expect(lines).toEqual([
      expect.stringMatching(
        /^\[http\] \S+ POST \/api\/auth\/sign-in\/email 200 \d+ms error=invalid_client ua=-$/,
      ),
    ]);
  });
});
