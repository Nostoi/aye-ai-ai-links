import { FakeStore } from "./fake-store.js";
import { describeToolStoreContract } from "./tool-store-contract.js";

describeToolStoreContract("FakeStore tools", () => {
  const store = new FakeStore();
  return { store, addOwner: () => {}, eventsOf: (owner, id) => store.eventsOf(owner, id) };
});
