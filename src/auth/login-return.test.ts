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
