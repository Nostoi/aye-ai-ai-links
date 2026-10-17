import { FakeStore } from "./fake-store.js";
import { describeToolStoreContract } from "./tool-store-contract.js";

describeToolStoreContract("FakeStore tools", () => ({
  store: new FakeStore(),
  addOwner: () => {},
}));
