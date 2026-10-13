import { describe, expect, it } from "vitest";
import { consentPage, loginPage } from "./pages.js";

const ORIGIN = "https://links.example";

/** The page's own inline script, run against stand-ins for the DOM, `location` and `fetch`. */
function scriptOf(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("the page has no inline script");
  return match[1];
}

type Answer = { status: number; body: unknown };

async function run(html: string, search: string, answer: Answer, click?: string) {
  const handlers = new Map<string, (event: { preventDefault: () => void }) => Promise<void>>();
  const element = (id: string) => ({
    id,
    textContent: "",
    value: id === "email" ? "you@example.com" : "pw",
    addEventListener: (_: string, fn: (event: { preventDefault: () => void }) => Promise<void>) =>
      handlers.set(id, fn),
  });
  const elements = new Map<string, ReturnType<typeof element>>();
  const form = Object.assign(element("login"), {
    email: element("email"),
    password: element("pw"),
  });
  elements.set("login", form);
  const document = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    },
  };
  const location = { search, origin: ORIGIN, href: `${ORIGIN}/page${search}` };
  const sent: { url: string; body: unknown }[] = [];
  const fetch = async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
    };
  };
  new Function("document", "location", "fetch", scriptOf(html))(document, location, fetch);
  const handler = handlers.get(click ?? "login");
  if (!handler) throw new Error("the script registered no handler");
  await handler({ preventDefault: () => {} });
  return { location, sent, text: (id: string) => elements.get(id)?.textContent };
}

describe("the login page's script", () => {
  it("follows the url sign-in returns when it resumes an authorization", async () => {
    const signed = "?client_id=c&exp=1&sig=abc";
    const r = await run(loginPage(), signed, {
      status: 200,
      body: { redirect: true, url: "/consent?client_id=c&sig=abc" },
    });
    expect(r.sent).toEqual([
      {
        url: "/api/auth/sign-in/email",
        body: { email: "you@example.com", password: "pw", oauth_query: signed.slice(1) },
      },
    ]);
    expect(r.location.href).toBe("/consent?client_id=c&sig=abc");
  });

  it("returns to a same-origin authorize URL named by next", async () => {
    const next = "/api/auth/oauth2/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx&state=s";
    const r = await run(loginPage(), `?next=${encodeURIComponent(next)}`, {
      status: 200,
      body: { redirect: false },
    });
    expect(r.sent[0]?.body).not.toHaveProperty("oauth_query");
    expect(r.location.href).toBe(next);
  });

  it.each([
    ["another origin", "https://evil.example/api/auth/oauth2/authorize?x=1"],
    ["a protocol-relative URL", "//evil.example/api/auth/oauth2/authorize?x=1"],
    ["a longer path", "/api/auth/oauth2/authorizeX?x=1"],
    ["a path below it", "/api/auth/oauth2/authorize/x?x=1"],
    ["a dot segment", "/api/auth/oauth2/../sign-out"],
    ["another page", "/consent?x=1"],
    ["a javascript URL", "javascript:alert(1)"],
  ])("goes home instead of to %s", async (_, next) => {
    const r = await run(loginPage(), `?next=${encodeURIComponent(next)}`, {
      status: 200,
      body: { redirect: false },
    });
    expect(r.location.href).toBe("/");
  });

  it("stays on the page and says so when the password is wrong", async () => {
    const r = await run(loginPage(), "", { status: 401, body: {} });
    expect(r.location.href).toBe(`${ORIGIN}/page`);
    expect(r.text("error")).toBe("That email and password did not match.");
  });
});

describe("the consent page", () => {
  const query = "client_id=c&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&exp=1&sig=abc";

  it.each([
    ["accept", true],
    ["deny", false],
  ])("posts %s with the signed query, then follows the returned url", async (button, accept) => {
    const r = await run(
      consentPage({ clientName: "Claude", redirectHost: "claude.ai" }),
      `?${query}`,
      { status: 200, body: { redirect: true, url: "https://claude.ai/cb?code=1" } },
      button,
    );
    expect(r.sent).toEqual([
      { url: "/api/auth/oauth2/consent", body: { accept, oauth_query: query } },
    ]);
    expect(r.location.href).toBe("https://claude.ai/cb?code=1");
  });

  it("escapes the client's name and host", () => {
    const html = consentPage({ clientName: `<img src=x onerror="1">`, redirectHost: "a&b" });
    expect(html).toContain("&lt;img src=x onerror=&quot;1&quot;&gt;");
    expect(html).toContain("a&amp;b");
    expect(html).not.toContain("<img");
  });
});
