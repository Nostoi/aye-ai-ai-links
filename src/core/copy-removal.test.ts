import { describe, expect, it } from "vitest";
import { removeSavedCopy, restoreSavedCopy } from "./copy-removal.js";
import { CoreError } from "./errors.js";
import { FakeSavedCopies } from "./fake-saved-copies.js";
import { FakeStore } from "./fake-store.js";
import { copyLimits, MAX_COPY_BYTES } from "./saved-copy.js";
import { at, newLink } from "./snapshot-store-contract.js";

const OWNER = "o";

async function setup() {
  const store = new FakeStore();
  const copies = new FakeSavedCopies(store);
  const { link } = await store.insertIfAbsent(OWNER, newLink(1, at(0)));
  const draft = { markdown: "# Hi", imageUrls: [], nonce: "0".repeat(32) };
  await copies.saveCopy(OWNER, link.id, draft, copyLimits(10 * MAX_COPY_BYTES), at(2));
  let now = new Date(1_000_000);
  const deps = { savedCopies: copies, now: () => now };
  return {
    copies,
    deps,
    id: link.id,
    setNow: (ms: number) => {
      now = new Date(ms);
    },
  };
}

async function expectNotFound(attempt: Promise<unknown>) {
  const error = await attempt.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CoreError);
  expect((error as CoreError).code).toBe("not_found");
}

describe("removeSavedCopy and restoreSavedCopy", () => {
  it("restores a removal 60 000 ms later", async () => {
    const { copies, deps, id, setNow } = await setup();
    await removeSavedCopy(deps, OWNER, id);
    expect(copies.rowStatus(OWNER, id)).toBe("removed");
    setNow(1_060_000);
    await restoreSavedCopy(deps, OWNER, id);
    expect(copies.rowStatus(OWNER, id)).toBe("ok");
  });

  it("refuses a restore 60 001 ms later and leaves the copy removed", async () => {
    const { copies, deps, id, setNow } = await setup();
    await removeSavedCopy(deps, OWNER, id);
    setNow(1_060_001);
    await expectNotFound(restoreSavedCopy(deps, OWNER, id));
    expect(copies.rowStatus(OWNER, id)).toBe("removed");
  });

  it("refuses a second remove", async () => {
    const { deps, id } = await setup();
    await removeSavedCopy(deps, OWNER, id);
    await expectNotFound(removeSavedCopy(deps, OWNER, id));
  });

  it("refuses another owner's copy and leaves it ok", async () => {
    const { copies, deps, id } = await setup();
    await expectNotFound(removeSavedCopy(deps, "other", id));
    expect(copies.rowStatus(OWNER, id)).toBe("ok");
  });
});
