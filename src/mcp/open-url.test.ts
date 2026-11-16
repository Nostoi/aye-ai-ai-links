import { describe, expect, it } from "vitest";
import type { ModelReply } from "../ai/model.js";
import { scriptedModel } from "../ai/model-test-kit.js";
import { createAgentKey } from "../auth/agent-keys.js";
import { oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const OPEN_URL = /^https:\/\/links\.example\/o\/[A-Za-z0-9_-]{22}$/;

type Link = { id: string; url: string; openUrl: string | null };

let rpcId = 0;
async function call<T>(world: World, key: string, name: string, args: unknown): Promise<T> {
  const res = await world.app.fetch(
    new Request("https://links.example/mcp", {
      method: "POST",
      headers: {
        host: "links.example",
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const data = (await res.text()).split("\n").find((l) => l.startsWith("data:")) ?? "data:{}";
  const result = JSON.parse(data.slice(5)).result;
  expect(result?.isError, `${name}: ${JSON.stringify(result?.content)}`).not.toBe(true);
  return result.structuredContent as T;
}

const codeRows = (world: World) =>
  world.links.prepare("SELECT link_id AS link, agent FROM link_open_codes ORDER BY rowid").all();

async function library() {
  const world = await oauthWorld();
  const deps = createDeps(world.links, new FakeEmbedder(DIMS));
  const save = async (url: string, title: string) =>
    (await saveLink(deps, A, { url, title, savedBy: "t" })).link;
  const key = (agent: string) =>
    createAgentKey(world.keyStore, { owner: A, ownerName: "A", agent }).key;
  return { world, save, key };
}

describe("openUrl at the MCP door (#133)", () => {
  it("gives each web link an absolute open link for the calling agent, the same on every tool", async () => {
    const { world, save, key } = await library();
    const web = await save("https://ex.com/batteries", "home batteries");
    const bare = await save("http:ex.com/bare", "bare batteries");
    const claude = key("Claude");

    const found = await call<{ links: Link[] }>(world, claude, "search_links", {
      query: "batteries",
    });
    const got = await call<{ link: Link }>(world, claude, "get_link", { id: web.id });
    const listed = await call<{ links: Link[] }>(world, claude, "list_links", {});
    const digest = await call<{ links: { link: Link }[] }>(world, claude, "get_digest", {});
    const resaved = await call<{ link: Link }>(world, claude, "save_link", { url: web.url });
    const codex = await call<{ link: Link }>(world, key("codex"), "get_link", { id: web.id });

    const byId = (links: Link[]) => Object.fromEntries(links.map((l) => [l.id, l.openUrl]));
    const openUrl = got.link.openUrl;
    expect(openUrl).toMatch(OPEN_URL);
    expect(byId(found.links)).toEqual({ [web.id]: openUrl, [bare.id]: null });
    expect(byId(listed.links)).toEqual({ [web.id]: openUrl, [bare.id]: null });
    expect(byId(digest.links.map((d) => d.link))[web.id]).toBe(openUrl);
    expect(resaved.link.openUrl).toBe(openUrl);
    expect(codex.link.openUrl).toMatch(OPEN_URL);
    expect(codex.link.openUrl).not.toBe(openUrl);
    expect(codeRows(world)).toEqual([
      { link: Number(web.id), agent: "Claude" },
      { link: Number(web.id), agent: "codex" },
    ]);
  });

  it("an opening through it pairs only with the agent's search that returned the link (O1)", async () => {
    const { world, save, key } = await library();
    const batteries = await save("https://ex.com/batteries", "home batteries");
    await save("https://ex.com/tiles", "kitchen tiles");
    const claude = key("Claude");
    const first = await call<{ links: Link[] }>(world, claude, "search_links", {
      query: "batteries",
    });
    await call(world, claude, "search_links", { query: "tiles" });
    const openUrl = first.links.find((l) => l.id === batteries.id)?.openUrl as string;

    const sent = await world.agent().send(new URL(openUrl).pathname, { method: "POST" });

    expect(sent.status).toBe(204);
    expect(
      world.links
        .prepare("SELECT query, opened_link_id AS opened FROM search_log ORDER BY id")
        .all(),
    ).toEqual([
      { query: "batteries", opened: Number(batteries.id) },
      { query: "tiles", opened: null },
    ]);
  });
});

describe("the in-app AI (#133, O7)", () => {
  it("gets no openUrl and makes no code", async () => {
    const reply = (text: string): ModelReply => ({ text, toolCalls: [] });
    const model = scriptedModel("Fake", [
      { text: "", toolCalls: [{ id: "c0", name: "search_links", arguments: { query: "" } }] },
      reply("Here."),
    ]);
    const world = await oauthWorld({ ai: model });
    const deps = createDeps(world.links, new FakeEmbedder(DIMS));
    const { link } = await saveLink(deps, A, { url: "https://ex.com/batteries", savedBy: "t" });
    const browser = world.agent();
    await browser.signIn();

    const res = await browser.send("/ai/chat", {
      method: "POST",
      json: { history: [], text: "What's saved?" },
    });

    expect((res.body as { ok: boolean }).ok).toBe(true);
    const [answer] = (model.requests[1]?.messages ?? []).filter((m) => m.role === "tool");
    const sent = JSON.parse(answer?.role === "tool" ? answer.text : "{}") as { links: Link[] };
    expect(sent.links.map((l) => [l.id, l.openUrl])).toEqual([[link.id, null]]);
    expect(codeRows(world)).toEqual([]);
  });
});
