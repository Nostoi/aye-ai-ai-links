import { describe, expect, it } from "vitest";
import { scriptedModel } from "../ai/model-test-kit.js";
import { createAgentKey } from "../auth/agent-keys.js";
import { oauthWorld, SECOND_USER, type World } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const A = "owner";
const B = SECOND_USER.id;
const TEXT = "You save far more than you open.";
// After the links these tests save (stamped with the clock), so the reading is visible.
const WRITTEN_AT = new Date(Date.now() + 86_400_000);

async function getStats(world: World, key: string) {
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
        id: 1,
        method: "tools/call",
        params: { name: "get_stats", arguments: {} },
      }),
    }),
  );
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse((line ?? "data:{}").slice(5)).result;
}

async function open(ai?: ReturnType<typeof scriptedModel>) {
  const world = await oauthWorld(ai ? { ai } : {});
  const deps = createDeps(world.links, new FakeEmbedder(DIMS));
  deps.store.ensureUser(B, "B");
  for (const owner of [A, B]) {
    await saveLink(deps, owner, { url: `https://example.com/${owner}`, savedBy: "t" });
  }
  await deps.statsReadings.putReadingIf(A, null, {
    text: TEXT,
    writtenBy: "Fake",
    writtenAt: WRITTEN_AT,
    inputHash: "h",
  });
  return {
    world,
    a: createAgentKey(world.keyStore, { owner: A, ownerName: "A", agent: "agent-a" }).key,
    b: createAgentKey(world.keyStore, { owner: B, ownerName: "B", agent: "agent-b" }).key,
  };
}

describe("get_stats reading", () => {
  it("get_stats returns the stored reading as inferred", async () => {
    const { world, a } = await open(scriptedModel("Fake", []));
    const result = await getStats(world, a);
    expect(result.structuredContent.reading).toEqual({
      text: TEXT,
      writtenBy: "Fake",
      writtenAt: WRITTEN_AT.toISOString(),
      source: "inferred",
    });
  });

  it("B never sees A's reading", async () => {
    const { world, b } = await open(scriptedModel("Fake", []));
    const result = await getStats(world, b);
    expect(result.structuredContent.saved).toBe(1);
    expect(result.structuredContent.reading).toBeNull();
    expect(JSON.stringify(result)).not.toContain(TEXT);
  });

  it("with no AI connection a stored reading is not shown, and the counts still are", async () => {
    const { world, a } = await open();
    const result = await getStats(world, a);
    expect(result.structuredContent.reading).toBeNull();
    expect(result.structuredContent.saved).toBe(1);
    expect(JSON.stringify(result)).not.toContain(TEXT);
  });
});
