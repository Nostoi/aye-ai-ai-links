import { FakeStore } from "./fake-store.js";
import { describeFaviconStoreContract } from "./favicon-store-contract.js";

describeFaviconStoreContract("FakeStore favicons", () => {
  const store = new FakeStore();
  return {
    links: store,
    images: store,
    favicons: store,
    addOwner: () => {},
    row: (o, id) => store.faviconRow(o, id),
  };
});
