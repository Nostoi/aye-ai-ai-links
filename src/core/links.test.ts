import { FakeStore } from "./fake-store.js";
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
