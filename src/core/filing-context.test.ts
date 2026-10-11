import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.js";
import { filingContext } from "./filing-context.js";
import type { Tag } from "./types.js";

const tag = (key: string, over: Partial<Tag> = {}): Tag => ({
  key,
  name: key,
  kind: "topic",
  color: null,
  pinned: false,
  description: null,
  projectStatus: null,
  ...over,
});

describe("filingContext", () => {
  it("lists every tag and only the not-done projects as active, in key order", async () => {
    const store = new FakeStore();
    store.seedTag("a", tag("zeta", { kind: "project", projectStatus: "active" }));
    store.seedTag("a", tag("topic"));
    store.seedTag("a", tag("old", { kind: "project", projectStatus: "done" }));
    store.seedTag("a", tag("bare", { kind: "project" }));
    const ctx = await filingContext({ store }, "a");
    expect(ctx.tags.map((t) => t.key)).toEqual(["bare", "old", "topic", "zeta"]);
    expect(ctx.activeProjects.map((t) => t.key)).toEqual(["bare", "zeta"]);
  });

  it("never includes another owner's tags", async () => {
    const store = new FakeStore();
    store.seedTag("a", tag("mine", { kind: "project" }));
    store.seedTag("b", tag("theirs", { kind: "project" }));
    const ctx = await filingContext({ store }, "a");
    expect(ctx.tags.map((t) => t.key)).toEqual(["mine"]);
    expect(ctx.activeProjects.map((t) => t.key)).toEqual(["mine"]);
  });
});
