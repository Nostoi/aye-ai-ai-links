import { FakeStore } from "./fake-store.js";
import { describeIconBackfillStoreContract } from "./icon-backfill-store-contract.js";

describeIconBackfillStoreContract("FakeStore icon backfill", () => {
  const store = new FakeStore();
  return {
    links: store,
    images: store,
    checks: store,
    edits: store,
    addOwner: () => {},
    imageStatus: (o, id) => store.imageStatusOf(o, id),
    forgetIconCheck: (o, id) => store.forgetIconCheck(o, id),
  };
});
