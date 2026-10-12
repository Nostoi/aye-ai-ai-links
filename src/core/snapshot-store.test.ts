import { FakeStore } from "./fake-store.js";
import { describeSnapshotStoreContract } from "./snapshot-store-contract.js";

describeSnapshotStoreContract("FakeStore snapshots", () => ({
  store: new FakeStore(),
  addOwner: () => {},
}));
