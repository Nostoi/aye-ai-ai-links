import { FakeStore } from "./fake-store.js";
import { describeLinkEditStoreContract } from "./link-edit-store-contract.js";

describeLinkEditStoreContract("FakeStore edits", () => {
  const store = new FakeStore();
  return { links: store, images: store, edits: store, addOwner: () => {} };
});
