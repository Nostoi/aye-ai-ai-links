import { describe, expect, it } from "vitest";
import { loginRedirect, returnAfterLogin } from "./login-return.js";

describe("returnAfterLogin", () => {
  it("returns a same-origin authorize URL, path and query", () => {
    const next = "/api/auth/oauth2/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx&state=s";
    expect(returnAfterLogin(next)).toBe(next);
  });

  it.each([
    ["no next", null],
    ["a next that does not parse", "http://["],
    ["another origin", "https://evil.example/api/auth/oauth2/authorize?x=1"],
    ["a protocol-relative URL", "//evil.example/api/auth/oauth2/authorize?x=1"],
    ["a longer path", "/api/auth/oauth2/authorizeX?x=1"],
    ["a path below it", "/api/auth/oauth2/authorize/x?x=1"],
    ["a dot segment", "/api/auth/oauth2/../sign-out"],
    ["another page", "/consent?x=1"],
    ["a javascript URL", "javascript:alert(1)"],
  ])("goes home instead of to %s", (_, next) => {
    expect(returnAfterLogin(next)).toBe("/");
  });

  it("returns what the authorize gate sent to the login page", () => {
    const authorize = new URL(
      "https://links.example/api/auth/oauth2/authorize?client_id=https%3A%2F%2Fclaude.ai%2Fx&state=s",
    );
    const location = loginRedirect(authorize);
    expect(location.startsWith("/login?next=%2Fapi%2Fauth%2Foauth2%2Fauthorize")).toBe(true);
    const next = new URL(location, "https://links.example").searchParams.get("next");
    expect(returnAfterLogin(next)).toBe(`${authorize.pathname}${authorize.search}`);
  });
});

describe("returnAfterLogin and the Save page", () => {
  const BASE = "https://links.example";

  it("returns the Save page with its url and title", () => {
    const back = returnAfterLogin("/save?url=https%3A%2F%2Fex.com%2Fa%3Fb%3D1&title=Hi%20there");
    const parsed = new URL(back, BASE);
    expect(parsed.pathname).toBe("/save");
    expect([...parsed.searchParams]).toEqual([
      ["url", "https://ex.com/a?b=1"],
      ["title", "Hi there"],
    ]);
  });

  it("drops any other parameter, a repeated one and a fragment", () => {
    const next =
      "/save?x=1&url=https%3A%2F%2Fex.com&url=https%3A%2F%2Fevil.example&title=T&next=%2F#frag";
    expect(returnAfterLogin(next)).toBe("/save?url=https%3A%2F%2Fex.com&title=T");
  });

  it("returns a bare /save for a Save address with neither url nor title", () => {
    expect(returnAfterLogin("/save?long=1")).toBe("/save");
  });

  it("resolves a dot segment before comparing the path", () => {
    expect(returnAfterLogin("/x/../save?title=T")).toBe("/save?title=T");
  });

  it.each([
    ["/save/"],
    ["/save;x"],
    ["/save/."],
    ["/saveX"],
    ["/Save"],
    ["/save%2F"],
    ["/save/../connections"],
    ["//evil.example/save?url=x"],
    ["/\\evil.example/save?url=x"],
    ["https://evil.example/save?url=x"],
    ["javascript:alert(1)"],
  ])("goes home instead of to %s", (next) => {
    expect(returnAfterLogin(next)).toBe("/");
  });

  it("round trip: what the Save page sends to sign-in comes back as the same Save address", () => {
    const save = new URL(
      `${BASE}/save?url=https%3A%2F%2Fex.com%2Fa%2Bb%3Fq%3Dc%20d&title=Caf%C3%A9%20%2B%20%F0%9F%98%80`,
    );
    const location = loginRedirect(save);
    expect(location.startsWith("/login?next=%2Fsave%3F")).toBe(true);
    const next = new URL(location, BASE).searchParams.get("next");
    const back = new URL(returnAfterLogin(next), BASE);
    expect(back.pathname).toBe("/save");
    expect(back.searchParams.get("url")).toBe("https://ex.com/a+b?q=c d");
    expect(back.searchParams.get("title")).toBe("Café + 😀");
  });
});
