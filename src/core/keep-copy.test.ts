import { describe, expect, it } from "vitest";
import { FakeSavedCopies } from "./fake-saved-copies.js";
import { FakeStore } from "./fake-store.js";
import { createCopyKeeper } from "./keep-copy.js";
import { MAX_COPY_MARKDOWN_BYTES } from "./saved-copy.js";
import { A, at, B, newLink } from "./snapshot-store-contract.js";
import type { ToolRecord } from "./tool-store.js";

const nonce = "0".repeat(32);
const draft = (markdown = "# Hello") => ({ markdown, imageUrls: [], nonce });
const tool = (status: ToolRecord["status"]): ToolRecord => ({
  status,
  source: "stated",
  since: at(0),
  answeredAt: null,
  waitDays: 30,
});

async function setup(limitBytes = 100 * 1024 * 1024) {
  const store = new FakeStore();
  const copies = new FakeSavedCopies(store);
  const link = (await store.insertIfAbsent(A, newLink(1, at(0)))).link;
  const keeper = createCopyKeeper({ copies, tools: store, limitBytes, now: () => at(5) });
  return { store, copies, link, keeper };
}

describe("copy keeper", () => {
  it("saves a plain link's copy, and a second keep finds it there", async () => {
    const { copies, link, keeper } = await setup();
    expect(await keeper.keep(A, link.id, draft("# Hello"))).toBe("saved");
    expect(await keeper.keep(A, link.id, draft("# Again"))).toBe("exists");
    expect(await copies.readCopy(A, link.id)).toMatchObject({ markdown: "# Hello" });
  });

  it("saves a suggested tool's copy", async () => {
    const { store, copies, link, keeper } = await setup();
    await store.updateToolIf(A, link.id, null, tool("suggested"));
    expect(await keeper.keep(A, link.id, draft())).toBe("saved");
    expect(await copies.readCopy(A, link.id)).not.toBeNull();
  });

  it("records no copy for a kept tool", async () => {
    const { store, copies, link, keeper } = await setup();
    await store.updateToolIf(A, link.id, null, tool("kept"));
    expect(await keeper.keep(A, link.id, draft())).toBe("tool");
    expect(await copies.readCopy(A, link.id)).toBeNull();
    // The none row stands: a later keep writes nothing.
    expect(await keeper.keep(A, link.id, draft())).toBeNull();
  });

  it("measures the cap in bytes, not characters", async () => {
    const { copies, link, keeper } = await setup();
    // "é" is 2 bytes and 1 code unit: over the cap in bytes, under it in characters.
    const over = "é".repeat(MAX_COPY_MARKDOWN_BYTES / 2 + 1);
    expect(over.length).toBeLessThan(MAX_COPY_MARKDOWN_BYTES);
    expect(await keeper.keep(A, link.id, draft(over))).toBe("too_large");
    expect(await copies.readCopy(A, link.id)).toBeNull();
    expect(await keeper.keep(A, link.id, draft("x"))).toBe("exists");
  });

  it("saves markdown of exactly the cap", async () => {
    const { copies, link, keeper } = await setup();
    const exact = "é".repeat(MAX_COPY_MARKDOWN_BYTES / 2);
    expect(await keeper.keep(A, link.id, draft(exact))).toBe("saved");
    expect(await copies.readCopy(A, link.id)).not.toBeNull();
  });

  it("writes nothing for another owner's link", async () => {
    const { copies, link, keeper } = await setup();
    const big = "é".repeat(MAX_COPY_MARKDOWN_BYTES / 2 + 1);
    expect(await keeper.keep(B, link.id, draft())).toBeNull();
    expect(await keeper.keep(B, link.id, draft(big))).toBeNull();
    expect(await copies.readCopy(B, link.id)).toBeNull();
    // No row was made for the real owner either.
    expect(await keeper.keep(A, link.id, draft())).toBe("saved");
  });

  it("lets a store error reach the caller", async () => {
    const { copies, link, keeper } = await setup();
    copies.failNextWrite(new Error("disk"));
    await expect(keeper.keep(A, link.id, draft())).rejects.toThrow("disk");
  });

  it("wants copies only when the limit is above zero", async () => {
    expect((await setup(0)).keeper.wanted).toBe(false);
    expect((await setup(1)).keeper.wanted).toBe(true);
  });
});
