import { FakeStore } from "./fake-store.js";
import { describeTagSuggestStoreContract } from "./tag-suggest-store-contract.js";

describeTagSuggestStoreContract("FakeStore tag suggestions", () => {
  const store = new FakeStore();
  return { links: store, tagSuggest: store, addOwner: () => {} };
});
