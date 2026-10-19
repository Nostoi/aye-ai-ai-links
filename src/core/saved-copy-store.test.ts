import { describe, expect, it } from "vitest";
import { FakeSavedCopies } from "./fake-saved-copies.js";
import { FakeStore } from "./fake-store.js";
import { copyLimits } from "./saved-copy.js";
import { describeSavedCopyStoreContract } from "./saved-copy-store-contract.js";
import { A, at, B, newLink } from "./snapshot-store-contract.js";

describeSavedCopyStoreContract("FakeSavedCopies", () => {
  const store = new FakeStore();
  const copies = new FakeSavedCopies(store);
  return {
    links: store,
    checks: store,
    copies,
    addOwner: () => {},
    breakFolder: () => copies.fail("mismatch"),
  };
});

describe("FakeSavedCopies fault injection", () => {
  const setup = async () => {
    const store = new FakeStore();
    const copies = new FakeSavedCopies(store);
    const { link } = await store.insertIfAbsent(A, newLink(1, at(0)));
    return { copies, id: link.id };
  };
  const draft = (n: number) => ({
    markdown: "body",
    imageUrls: [...Array(n)].map((_, i) => `https://img.example/${i + 1}.png`),
    nonce: "0123456789abcdef0123456789abcdef",
  });
  const limits = copyLimits(10_000);

  it("releases a copy whose write throws, and rethrows the error", async () => {
    const { copies, id } = await setup();
    const boom = new Error("disk full");
    copies.failNextWrite(boom);
    await expect(copies.saveCopy(A, id, draft(0), limits, at(5))).rejects.toBe(boom);
    expect(await copies.usedBytes()).toBe(0);
    expect(await copies.readCopy(A, id)).toBeNull();
    expect(await copies.saveCopy(A, id, draft(0), limits, at(6))).toBe("saved");
  });

  it("puts an image whose write throws back to pending, charging nothing", async () => {
    const { copies, id } = await setup();
    await copies.saveCopy(A, id, draft(1), limits, at(5));
    const used = await copies.usedBytes();
    const boom = new Error("EPERM");
    copies.failNextWrite(boom);
    const image = { contentType: "image/png" as const, bytes: new Uint8Array(4).fill(1) };
    const url = "https://img.example/1.png";
    await expect(copies.saveCopyImage(A, id, 1, url, image, limits)).rejects.toBe(boom);
    expect(await copies.usedBytes()).toBe(used);
    expect((await copies.pendingCopyImages(null, 10)).map((p) => p.n)).toEqual([1]);
    expect(await copies.saveCopyImage(A, id, 1, url, image, limits)).toBe("saved");
  });

  it("answers its last folder check, starting ready", async () => {
    const { copies } = await setup();
    expect(copies.lastCheck()).toEqual({ state: "ready" });
    copies.fail("unwritable");
    expect(copies.lastCheck()).toEqual({ state: "ready" });
    const failed = await copies.checkFolder();
    expect(failed).toMatchObject({ state: "unwritable" });
    expect(copies.lastCheck()).toEqual(failed);
    copies.heal();
    await copies.checkFolder();
    expect(copies.lastCheck()).toEqual({ state: "ready" });
  });

  it("loses a copy's files: the copy reads as missing and gets no more pictures", async () => {
    const { copies, id } = await setup();
    await copies.saveCopy(A, id, draft(1), limits, at(5));
    expect(await copies.copyFileMissing(A, id)).toBe(false);
    copies.loseFiles(A, id);
    expect(await copies.copyFileMissing(A, id)).toBe(true);
    expect(await copies.copyFileMissing(B, id)).toBe(false);
    expect(await copies.readCopy(A, id)).toBe("missing");
    const used = await copies.usedBytes();
    const image = { contentType: "image/png" as const, bytes: new Uint8Array(4).fill(1) };
    await expect(
      copies.saveCopyImage(A, id, 1, "https://img.example/1.png", image, limits),
    ).rejects.toThrow();
    expect(await copies.usedBytes()).toBe(used);
    expect((await copies.pendingCopyImages(null, 10)).map((p) => p.n)).toEqual([1]);
    copies.fail("mismatch");
    await copies.checkFolder();
    expect(await copies.copyFileMissing(A, id)).toBe(false);
  });
});
