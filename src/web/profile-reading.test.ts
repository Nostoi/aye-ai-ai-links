import { describe, expect, it } from "vitest";
import { scriptedModel } from "../ai/model-test-kit.js";
import { oauthWorld } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const TEXT = "You save far more than you open.";

async function seeded(ai?: ReturnType<typeof scriptedModel>) {
  const world = await oauthWorld(ai ? { ai } : {});
  const deps = createDeps(world.links, new FakeEmbedder(DIMS));
  await saveLink(deps, "owner", { url: "https://example.com/r", savedBy: "t" });
  const wrote = await deps.statsReadings.putReadingIf("owner", null, {
    text: TEXT,
    writtenBy: "Fake",
    writtenAt: new Date("2026-10-20T08:00:00Z"),
    inputHash: "h",
  });
  expect(wrote).toBe(true);
  const browser = world.agent();
  await browser.signIn();
  return browser;
}

describe("the profile page's reading", () => {
  it("shows the stored reading when an AI connection is set up", async () => {
    const html = String((await (await seeded(scriptedModel("Fake", []))).send("/profile")).body);
    expect(html).toContain(TEXT);
    expect(html).toContain("A guess by Fake");
  });

  it("with no AI connection a stored reading is not shown, and the counts still are", async () => {
    const html = String((await (await seeded()).send("/profile")).body);
    expect(html).not.toContain(TEXT);
    expect(html).not.toContain("What this might say about you");
    expect(html).toContain("Your library");
    expect(html).toContain('<p class="stat-count">1</p>');
  });
});
