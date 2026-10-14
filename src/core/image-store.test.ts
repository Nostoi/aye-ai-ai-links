import { FakeStore } from "./fake-store.js";
import { describeImageStoreContract } from "./image-store-contract.js";

describeImageStoreContract("FakeStore images", () => {
  const store = new FakeStore();
  return { links: store, images: store, addOwner: () => {} };
});
