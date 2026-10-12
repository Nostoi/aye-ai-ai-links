import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.js";
import { saveLink } from "./links.js";
import { describeStoreContract, type StoreHarness } from "./store-contract.js";

function harnessFor(store: FakeStore): StoreHarness {
  return {
    store,
    addOwner: () => {},
    all: (owner) => store.all(owner),
    catalog: (owner) => store.catalog(owner),
    seedTag: (owner, tag) => store.seedTag(owner, tag),
  };
}

describeStoreContract("FakeStore", () => harnessFor(new FakeStore()));

describe("saveLink and page snapshots", () => {
  const setup = () => {
    const kicks: [string, string][] = [];
    const deps = {
      store: new FakeStore(),
      now: () => new Date("2026-01-01T00:00:00Z"),
      snapshots: {
        kick: async (owner: string, linkId: string) => {
          kicks.push([owner, linkId]);
        },
      },
    };
    return { deps, kicks };
  };

  it("kicks the snapshot of a new link, and never of a repeat save", async () => {
    const { deps, kicks } = setup();
    const first = await saveLink(deps, "a", { url: "https://ex.com/a", savedBy: "agent" });
    await saveLink(deps, "a", { url: "https://ex.com/a", savedBy: "agent" });
    // The repeat that fills a missing why takes its own branch.
    await saveLink(deps, "a", {
      url: "https://ex.com/a",
      savedBy: "agent",
      why: { text: "for the trip", source: "stated" },
    });
    expect(kicks).toEqual([["a", first.link.id]]);
  });

  it("saves without a snapshot runner", async () => {
    const { deps } = setup();
    const { snapshots: _, ...bare } = deps;
    const saved = await saveLink(bare, "a", { url: "https://ex.com/a", savedBy: "agent" });
    expect(saved.created).toBe(true);
  });
});
