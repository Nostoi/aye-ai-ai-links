import { FakeStore } from "./fake-store.js";
import { describeLinkCheckStoreContract } from "./link-check-store-contract.js";

describeLinkCheckStoreContract("FakeStore checks", () => {
  const store = new FakeStore();
  return { links: store, checks: store, addOwner: () => {} };
});
