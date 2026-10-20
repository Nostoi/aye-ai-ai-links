import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { scriptedModel } from "../ai/model-test-kit.js";
import { oauthWorld } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

/** The Ask AI panel is on every menu page when an AI is set up, and on none when it is not (#159). */

const PAGES: [path: string, status: number, place: string][] = [
  ["/", 200, "Home"],
  ["/all", 200, "All links"],
  ["/search?q=x", 200, "Search"],
  ["/tags", 200, "Tags"],
  ["/profile", 200, "Profile"],
  ["/connections", 200, "Apps and keys"],
  ["/spaces?tag=nothing", 404, "this page"],
  ["/all?order=bogus", 400, "this page"],
];

const signedIn = async (ai?: ReturnType<typeof scriptedModel>) => {
  const world = await oauthWorld(ai ? { ai } : {});
  const browser = world.agent();
  await browser.signIn();
  return browser;
};

describe("the Ask AI panel on the menu pages", () => {
  it("is on every menu page with an AI set up, naming the AI, the page and the signed-in owner", async () => {
    const browser = await signedIn(scriptedModel("Fake", []));
    for (const [path, status, place] of PAGES) {
      const res = await browser.send(path);
      expect(res.status, path).toBe(status);
      const { document } = parseHTML(String(res.body));
      expect(document.getElementById("ask-open"), path).not.toBeNull();
      expect(document.querySelector(".ask-title p")?.textContent, path).toBe(
        `Using Fake, on ${place}`,
      );
      expect(document.getElementById("ask-panel")?.getAttribute("data-owner"), path).toBe("owner");
    }
  });

  it("is on none of them with no AI set up", async () => {
    const browser = await signedIn();
    for (const [path, status] of PAGES) {
      const res = await browser.send(path);
      expect(res.status, path).toBe(status);
      const html = String(res.body);
      expect(html, path).not.toContain("ask-open");
      expect(html, path).not.toContain("ask-panel");
      expect(html, path).not.toContain("aye-ask");
    }
  });

  it("names a space page by the space, escaped", async () => {
    const world = await oauthWorld({ ai: scriptedModel("Fake", []) });
    const deps = createDeps(world.links, new FakeEmbedder(DIMS));
    await saveLink(deps, "owner", {
      url: "https://a.example/x",
      title: "X",
      savedBy: "seed",
      tags: [{ name: "Kitchen <b>", source: "stated" }],
    });
    const browser = world.agent();
    await browser.signIn();
    const res = await browser.send("/spaces?tag=kitchen <b>");
    expect(res.status).toBe(200);
    expect(String(res.body)).not.toContain("on Kitchen <b>");
    expect(parseHTML(String(res.body)).document.querySelector(".ask-title p")?.textContent).toBe(
      "Using Fake, on Kitchen <b>",
    );
  });
});
