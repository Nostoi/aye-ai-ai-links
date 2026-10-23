import { FakeStore } from "./fake-store.js";
import { describeTagEditStoreContract } from "./tag-edit-store-contract.js";

describeTagEditStoreContract("FakeStore tag edits", () => {
  const store = new FakeStore();
  return { links: store, edits: store, tagEdits: store, addOwner: () => {} };
});
