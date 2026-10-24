import { describe, expect, it } from "vitest";
import { createAgentKey } from "../auth/agent-keys.js";
import { oauthWorld, type World } from "../auth/oauth-test-kit.js";

const A = "owner";

type Called = { isError: boolean; data: unknown; text: string };
type Counted = { key: string; name: string; links: number };

let rpcId = 0;
/** Every request to the door builds a new MCP server, so each call is a fresh session. */
async function call(world: World, key: string, name: string, args: unknown): Promise<Called> {
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
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data:"));
  const result = JSON.parse((line ?? "data:{}").slice(5)).result;
  return {
    isError: result?.isError === true,
    data: result?.structuredContent,
    text: String(result?.content?.[0]?.text ?? ""),
  };
}

async function open() {
  const world = await oauthWorld({});
  const key = createAgentKey(world.keyStore, { owner: A, ownerName: "A", agent: "agent-a" }).key;
  const save = async (url: string, ...names: string[]) => {
    const res = await call(world, key, "save_link", {
      url,
      tags: names.map((name) => ({ name, source: "stated" })),
    });
    expect(res.isError, res.text).toBe(false);
  };
  const tags = async () =>
    ((await call(world, key, "list_tags", {})).data as { tags: Counted[] }).tags.map(
      (t) => `${t.key}:${t.links}`,
    );
  return { world, key, save, tags };
}

describe("tag tools", () => {
  it("list_tags gives every tag with its link count", async () => {
    const { save, tags } = await open();
    await save("https://example.com/1", "Banking", "Pixel Art");
    await save("https://example.com/2", "Banking");
    expect((await tags()).sort()).toEqual(["banking:2", "pixel art:1"]);
  });

  it("update_tag newName renames the tag and the old name no longer lists", async () => {
    const { world, key, save, tags } = await open();
    await save("https://example.com/1", "banking");
    const res = await call(world, key, "update_tag", { name: "banking", newName: "Finance" });
    expect(res.isError, res.text).toBe(false);
    expect(res.data).toMatchObject({ tag: { key: "finance", name: "Finance" } });
    expect(await tags()).toEqual(["finance:1"]);
  });

  it("update_tag newName onto an existing tag errors naming it and changes nothing", async () => {
    const { world, key, save, tags } = await open();
    await save("https://example.com/1", "banking");
    await save("https://example.com/2", "Finance");
    const res = await call(world, key, "update_tag", { name: "banking", newName: "finance" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Finance");
    expect(res.text).toContain("merge_tags");
    expect((await tags()).sort()).toEqual(["banking:1", "finance:1"]);
  });

  it("update_tag needs exactly one of kind and newName", async () => {
    const { world, key, save, tags } = await open();
    await save("https://example.com/1", "banking");
    const both = await call(world, key, "update_tag", {
      name: "banking",
      kind: "project",
      newName: "finance",
    });
    expect(both.isError).toBe(true);
    expect(both.text).toMatch(/two calls/);
    const neither = await call(world, key, "update_tag", { name: "banking" });
    expect(neither.isError).toBe(true);
    expect(await tags()).toEqual(["banking:1"]);
  });

  it("merge_tags then undo_tag_change from a fresh session puts everything back", async () => {
    const { world, key, save, tags } = await open();
    await save("https://example.com/1", "banking");
    await save("https://example.com/2", "finance", "banking");
    await save("https://example.com/3", "finance");
    const before = (await tags()).sort();

    const merged = await call(world, key, "merge_tags", { name: "banking", into: "finance" });
    expect(merged.isError, merged.text).toBe(false);
    const { tag, links, undoId } = merged.data as {
      tag: { key: string };
      links: number;
      undoId: string;
    };
    expect(tag.key).toBe("finance");
    expect(links).toBe(3);
    expect(undoId).toEqual(expect.any(String));
    expect(await tags()).toEqual(["finance:3"]);

    const undone = await call(world, key, "undo_tag_change", { undoId });
    expect(undone.isError, undone.text).toBe(false);
    expect(
      (undone.data as { tags: Counted[] }).tags.map((t) => `${t.key}:${t.links}`).sort(),
    ).toEqual(["banking:2", "finance:2"]);
    expect((await tags()).sort()).toEqual(before);
    const again = await call(world, key, "undo_tag_change", { undoId });
    expect(again.isError).toBe(true);
  });

  it("delete_tag takes the tag off its links and undo_tag_change brings it back", async () => {
    const { world, key, save, tags } = await open();
    await save("https://example.com/1", "banking", "keep");
    await save("https://example.com/2", "banking");
    const deleted = await call(world, key, "delete_tag", { name: "Banking" });
    expect(deleted.data).toMatchObject({ links: 2, undoId: expect.any(String) });
    expect(await tags()).toEqual(["keep:1"]);

    const { undoId } = deleted.data as { undoId: string };
    const undone = await call(world, key, "undo_tag_change", { undoId });
    expect(undone.data).toMatchObject({ tags: [{ key: "banking", links: 2 }] });
    expect((await tags()).sort()).toEqual(["banking:2", "keep:1"]);
  });

  it("an undo that no longer works says it may already have been undone and to check list_tags", async () => {
    const { world, key, save } = await open();
    await save("https://example.com/1", "a", "b");
    const { undoId } = (await call(world, key, "merge_tags", { name: "a", into: "b" })).data as {
      undoId: string;
    };
    await call(world, key, "undo_tag_change", { undoId });
    const again = await call(world, key, "undo_tag_change", { undoId });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/too late/);
    expect(again.text).toMatch(/already have been undone/);
    expect(again.text).toContain("list_tags");
    expect(again.text).toMatch(/tell the owner what it shows/);
    expect(again.text).not.toMatch(/check list_tags before offering to reverse/);
  });

  it("an undo blocked by a later undoable change does not promise undoing that one helps", async () => {
    const { world, key, save } = await open();
    await save("https://example.com/1", "a", "b");
    await save("https://example.com/2", "b", "c");
    const first = await call(world, key, "merge_tags", { name: "a", into: "b" });
    await call(world, key, "merge_tags", { name: "c", into: "b" });
    const res = await call(world, key, "undo_tag_change", {
      undoId: (first.data as { undoId: string }).undoId,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/later change to the same tags is in the way/);
    expect(res.text).not.toMatch(/can still be undone|undo the later change first/i);
  });

  it("names a tag that is missing", async () => {
    const { world, key } = await open();
    for (const [tool, args] of [
      ["merge_tags", { name: "nope", into: "also-nope" }],
      ["delete_tag", { name: "nope" }],
    ] as const) {
      const res = await call(world, key, tool, args);
      expect(res.isError).toBe(true);
      expect(res.text).toContain("nope");
    }
  });
});
