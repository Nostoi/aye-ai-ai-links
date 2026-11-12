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
    faviconRow: (o, id) => store.faviconRow(o, id),
    seedFavicon: (o, id, row) => store.seedFavicon(o, id, row),
  };
});
