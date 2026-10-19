import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.js";
import { boundedIconUrls } from "./snapshot-store.js";
import { describeSnapshotStoreContract } from "./snapshot-store-contract.js";

describeSnapshotStoreContract("FakeStore snapshots", () => ({
  store: new FakeStore(),
  addOwner: () => {},
}));

describe("boundedIconUrls", () => {
  const [one, two, three] = ["https://a/1.png", "https://a/2.png", "https://a/3.png"];
  it.each([
    ["a missing list", undefined, []],
    ["a number", 5, []],
    ["an object", {}, []],
    ["a string", "abc", []],
    ["null", null, []],
    ["an array with non-strings", [1, {}, one], [one]],
    ["two icons", [one, two], [one, two]],
    ["three icons", [one, two, three], [one, two]],
    ["non-strings before three icons", [null, one, 7, two, three], [one, two]],
  ])("reads %s as the icons a record may carry", (_name, value, want) => {
    expect(boundedIconUrls(value)).toEqual(want);
  });
});
