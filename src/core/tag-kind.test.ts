import { describe, expect, it } from "vitest";
import type { CoreError } from "./errors.js";
import { FakeStore } from "./fake-store.js";
import type { LinkStore } from "./store.js";
import { changeTagKind } from "./tag-kind.js";
import type { Tag } from "./types.js";

const solar: Tag = {
  key: "solar",
  name: "Solar",
  kind: "topic",
  kindSource: "inferred",
  color: null,
  pinned: false,
  description: null,
  projectStatus: null,
};

async function failure(p: Promise<unknown>): Promise<CoreError> {
  try {
    await p;
  } catch (e) {
    return e as CoreError;
  }
  throw new Error("expected a rejection");
}

describe("changeTagKind when the write keeps missing", () => {
  it("re-reads once, then reports a conflict instead of looping", async () => {
    const inner = new FakeStore();
    inner.seedTag("a", solar);
    let reads = 0;
    let writes = 0;
    const store = {
      listTags: (owner: string) => {
        reads++;
        return inner.listTags(owner);
      },
      updateTag: async () => {
        writes++;
        return null;
      },
    } as unknown as LinkStore;
    const error = await failure(changeTagKind({ store }, "a", { name: "solar", kind: "project" }));
    expect(error.code).toBe("conflict");
    expect(error.message).toContain("solar");
    expect(error.message).toContain("update_tag again");
    expect(error.message).not.toContain("save_link");
    expect([reads, writes]).toEqual([2, 2]);
  });

  it("reports not_found when the tag is gone on the re-read", async () => {
    const inner = new FakeStore();
    inner.seedTag("a", solar);
    let reads = 0;
    const store = {
      listTags: async (owner: string) => (++reads === 1 ? inner.listTags(owner) : []),
      updateTag: async () => null,
    } as unknown as LinkStore;
    const error = await failure(changeTagKind({ store }, "a", { name: "solar", kind: "project" }));
    expect(error.code).toBe("not_found");
    expect(error.message).toContain("search_links");
    expect(error.message).not.toContain("save_link");
  });
});
