import { FakeStore } from "./fake-store.js";
import { describeStatsReadingStoreContract } from "./stats-reading-store-contract.js";

describeStatsReadingStoreContract("FakeStore stats readings", () => {
  const store = new FakeStore();
  return { links: store, remover: store, readings: store, addOwner: () => {} };
});
