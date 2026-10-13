import { describe, expect, it } from "vitest";
import { memoryAuth, TEST_BASE_URL, TEST_EMAIL, TEST_PASSWORD } from "./memory-auth.js";
import { sessionIdentify } from "./session.js";

async function setup() {
  const t = await memoryAuth();
  const res = await t.auth.handler(
    new Request(`${TEST_BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: TEST_BASE_URL },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    }),
  );
  const cookie = res.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  const identify = sessionIdentify(t.auth, t.withAuthLock);
  const ask = (headers: HeadersInit = {}) =>
    identify(new Request(`${TEST_BASE_URL}/`, { headers }));
  return { ...t, cookie, ask };
}

describe("sessionIdentify", () => {
  it("names the session's user as the owner, saving as web", async () => {
    const t = await setup();
    expect(await t.ask({ cookie: t.cookie })).toEqual({
      owner: "owner",
      savedBy: "web",
      rateKey: "session:owner",
    });
  });

  it("returns null without a cookie, or with a forged one", async () => {
    const t = await setup();
    expect(await t.ask()).toBeNull();
    expect(await t.ask({ cookie: "__Secure-better-auth.session_token=forged.value" })).toBeNull();
  });

  it("returns null once the session has expired", async () => {
    const t = await setup();
    t.db
      .prepare(`UPDATE "session" SET expiresAt = ?`)
      .run(new Date(Date.now() - 1000).toISOString());
    expect(await t.ask({ cookie: t.cookie })).toBeNull();
  });
});
