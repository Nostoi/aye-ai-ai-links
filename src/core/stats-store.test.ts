import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.js";
import { at, newLink } from "./snapshot-store-contract.js";
import { describeStatsStoreContract } from "./stats-store-contract.js";

describeStatsStoreContract("FakeStore stats", () => {
  const start = at(1234);
  const store = new FakeStore({ trackingSince: start });
  return { links: store, remover: store, stats: store, start, addOwner: () => {} };
});

describe("FakeStore purge", () => {
  it("clears the purged link's events, as the table's cascade does", async () => {
    const store = new FakeStore();
    const { link } = await store.insertIfAbsent("o", newLink(1, at(0)));
    await store.update("o", link.id, {}, [{ record: "opened", at: at(1) }]);
    await store.markDeleted("o", link.id, at(2));
    expect(store.eventsOf("o", link.id)).toHaveLength(1);

    await store.purgeDeleted(at(3));

    expect(store.eventsOf("o", link.id)).toEqual([]);
  });
});
