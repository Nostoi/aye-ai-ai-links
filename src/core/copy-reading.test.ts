import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCopyReader, createReadGate } from "./copy-reading.js";
import { FakeSavedCopies } from "./fake-saved-copies.js";
import { FakeStore } from "./fake-store.js";
import { copyLimits, imageRef, MAX_COPY_BYTES } from "./saved-copy.js";
import { at, newLink } from "./snapshot-store-contract.js";

const OWNER = "o";
const NONCE = "0".repeat(32);
const PNG = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A copy reader over fakes whose reads can be held or made to throw. */
async function setup() {
  const store = new FakeStore();
  const copies = new FakeSavedCopies(store);
  const logged: string[] = [];
  const reader = createCopyReader({
    store,
    copies,
    gate: createReadGate(),
    log: (message) => logged.push(message),
  });
  const save = async (n: number, imageUrls: string[] = []) => {
    const { link } = await store.insertIfAbsent(OWNER, newLink(n, at(0)));
    const markdown =
      imageUrls.map((_, i) => `![a](${imageRef(i + 1, NONCE)})`).join("\n") || "# Hi";
    const draft = { markdown, imageUrls, nonce: NONCE };
    await copies.saveCopy(OWNER, link.id, draft, copyLimits(10 * MAX_COPY_BYTES), at(2));
    return link.id;
  };
  const bare = async (n: number) => (await store.insertIfAbsent(OWNER, newLink(n, at(0)))).link.id;
  /** Makes readCopy hang for `id` until the returned functions settle it. */
  const hold = (id: string) => {
    const real = copies.readCopy.bind(copies);
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const held = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const spy = vi.spyOn(copies, "readCopy").mockImplementation(async (owner, linkId) => {
      if (linkId === id) await held;
      return real(owner, linkId);
    });
    return { spy, resolve, reject };
  };
  return { store, copies, reader, logged, save, bare, hold };
}

describe("copy reader view", () => {
  it("answers an ok copy with its markdown and made-at time", async () => {
    const t = await setup();
    const id = await t.save(1);
    const view = await t.reader.view(OWNER, id);
    expect(view?.link.id).toBe(id);
    expect(view?.madeAt).toEqual(at(2));
    expect(view?.copy).toMatchObject({ markdown: "# Hi", finished: true });
  });

  it("answers null for another owner's link without reading a file", async () => {
    const t = await setup();
    const id = await t.save(1);
    const read = vi.spyOn(t.copies, "readCopy");
    expect(await t.reader.view("someone-else", id)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("answers null for a link with no copy without reading a file", async () => {
    const t = await setup();
    const id = await t.bare(1);
    const read = vi.spyOn(t.copies, "readCopy");
    expect(await t.reader.view(OWNER, id)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("answers missing when the folder does not match", async () => {
    const t = await setup();
    const id = await t.save(1);
    t.copies.fail("mismatch");
    expect((await t.reader.view(OWNER, id))?.copy).toBe("missing");
  });

  it("answers unreadable, with one log line, when the read throws", async () => {
    const t = await setup();
    const id = await t.save(1);
    vi.spyOn(t.copies, "readCopy").mockRejectedValue(new Error("EIO"));
    expect((await t.reader.view(OWNER, id))?.copy).toBe("unreadable");
    expect(t.logged).toEqual([`[saved copies] copy ${id} could not be read: EIO`]);
  });

  it("answers unreadable at 10 s for a read that never settles, not at 9.9 s", async () => {
    const t = await setup();
    const id = await t.save(1);
    t.hold(id);
    let answer: unknown;
    void t.reader.view(OWNER, id).then((v) => (answer = v?.copy));
    await vi.advanceTimersByTimeAsync(9_900);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(answer).toBe("unreadable");
    expect(t.logged).toEqual([`[saved copies] copy ${id} could not be read: timed out`]);
  });

  describe("one read at a time", () => {
    it("starts no second read while one hangs; the waiter answers unreadable at its own deadline", async () => {
      const t = await setup();
      const a = await t.save(1);
      const b = await t.save(2);
      const { spy } = t.hold(a);
      void t.reader.view(OWNER, a);
      await vi.advanceTimersByTimeAsync(5_000);
      let answer: unknown;
      void t.reader.view(OWNER, b).then((v) => (answer = v?.copy));
      await vi.advanceTimersByTimeAsync(9_900);
      expect(answer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(100);
      expect(answer).toBe("unreadable");
      expect(spy.mock.calls.map((c) => c[1])).toEqual([a]);
    });

    it("still answers null at once for a link with no copy", async () => {
      const t = await setup();
      const a = await t.save(1);
      const none = await t.bare(2);
      t.hold(a);
      void t.reader.view(OWNER, a);
      await vi.advanceTimersByTimeAsync(11_000);
      let answer: unknown = "pending";
      void t.reader.view(OWNER, none).then((v) => (answer = v));
      await vi.advanceTimersByTimeAsync(0);
      expect(answer).toBeNull();
    });

    it("reads again once the hung read settles", async () => {
      const t = await setup();
      const a = await t.save(1);
      const b = await t.save(2);
      const { spy, resolve } = t.hold(a);
      void t.reader.view(OWNER, a);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await settle(t.reader.view(OWNER, b)))?.copy).toBe("unreadable");
      expect(spy.mock.calls.map((c) => c[1])).toEqual([a]);
      resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect((await t.reader.view(OWNER, b))?.copy).toMatchObject({ markdown: "# Hi" });
      expect(spy.mock.calls.map((c) => c[1])).toEqual([a, b]);
    });

    it("raises no unhandled rejection when the hung read fails after its deadline", async () => {
      const t = await setup();
      const a = await t.save(1);
      const { reject } = t.hold(a);
      const view = t.reader.view(OWNER, a);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await view)?.copy).toBe("unreadable");
      reject(new Error("closed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(t.logged.at(-1)).toBe(`[saved copies] copy ${a} could not be read: closed`);
    });
  });

  /** Lets a waiter's deadline pass and answers its result. */
  async function settle<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(10_000);
    return p;
  }
});

describe("copy reader image", () => {
  const withImage = async () => {
    const t = await setup();
    const id = await t.save(1, ["https://e.test/a.png"]);
    await t.copies.saveCopyImage(
      OWNER,
      id,
      1,
      "https://e.test/a.png",
      { contentType: "image/png", bytes: PNG },
      copyLimits(10 * MAX_COPY_BYTES),
    );
    return { ...t, id };
  };

  it("answers the stored bytes", async () => {
    const t = await withImage();
    const image = await t.reader.image(OWNER, t.id, 1);
    expect(image).toMatchObject({ contentType: "image/png" });
    expect([...((image as { bytes: Uint8Array }).bytes ?? [])]).toEqual([...PNG]);
  });

  it("answers unreadable at 10 s for a read that never settles", async () => {
    const t = await withImage();
    vi.spyOn(t.copies, "copyImage").mockImplementation(() => new Promise(() => {}));
    let answer: unknown;
    void t.reader.image(OWNER, t.id, 1).then((v) => (answer = v));
    await vi.advanceTimersByTimeAsync(9_900);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(answer).toBe("unreadable");
  });

  it("answers unreadable when the read throws", async () => {
    const t = await withImage();
    vi.spyOn(t.copies, "copyImage").mockRejectedValue(new Error("EACCES"));
    expect(await t.reader.image(OWNER, t.id, 1)).toBe("unreadable");
    expect(t.logged).toEqual([`[saved copies] copy ${t.id} could not be read: EACCES`]);
  });

  it("answers null for an image that is not stored", async () => {
    const t = await withImage();
    expect(await t.reader.image(OWNER, t.id, 2)).toBeNull();
  });
});
