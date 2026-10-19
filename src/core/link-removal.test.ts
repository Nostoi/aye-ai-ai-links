import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreError } from "./errors.js";
import { FakeStore } from "./fake-store.js";
import {
  createLinkPurger,
  deleteLink,
  LINK_UNDO_WINDOW_MS,
  purgeDeletedLinks,
  restoreLink,
} from "./link-removal.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";
import { getLinkWithText, saveLink } from "./links.js";
import { listLinks } from "./list-links.js";
import { COPY_UNDO_WINDOW_MS } from "./saved-copy.js";
import { searchLinks } from "./search-links.js";
import { at, newLink } from "./snapshot-store-contract.js";
import { keepHandy, listShelf } from "./tools.js";

const OWNER = "o";
const T0 = 1_000_000;

async function setup() {
  const store = new FakeStore();
  const { link } = await store.insertIfAbsent(OWNER, newLink(1, at(0)));
  let t = T0;
  const deps = { store, now: () => new Date(t) };
  return {
    store,
    deps,
    id: link.id,
    setNow: (ms: number) => {
      t = ms;
    },
  };
}

async function expectNotFound(attempt: Promise<unknown>, message: string) {
  const error = await attempt.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CoreError);
  expect((error as CoreError).code).toBe("not_found");
  expect((error as CoreError).message).toBe(message);
}

describe("deleteLink and restoreLink", () => {
  it("deleteLink hides the link; a second delete is not_found with the reload message", async () => {
    const { store, deps, id } = await setup();
    await deleteLink(deps, OWNER, id);
    expect(await store.get(OWNER, id)).toBeNull();
    await expectNotFound(
      deleteLink(deps, OWNER, id),
      "That link is not there any more. Reload the page.",
    );
  });

  it("restoreLink inside 60 s brings it back; at 60 001 ms it is not_found with the too-late message and the link stays hidden", async () => {
    const early = await setup();
    await deleteLink(early.deps, OWNER, early.id);
    early.setNow(T0 + 60_000);
    await restoreLink(early.deps, OWNER, early.id);
    expect(await early.store.get(OWNER, early.id)).not.toBeNull();

    const late = await setup();
    await deleteLink(late.deps, OWNER, late.id);
    late.setNow(T0 + 60_001);
    await expectNotFound(
      restoreLink(late.deps, OWNER, late.id),
      "It's too late to undo: the link was deleted for good.",
    );
    expect(await late.store.get(OWNER, late.id)).toBeNull();
  });
});

describe("purgeDeletedLinks", () => {
  it("purges only links deleted more than 60 s ago", async () => {
    const { deps, id, setNow } = await setup();
    await deleteLink(deps, OWNER, id);
    setNow(T0 + 60_000);
    expect(await purgeDeletedLinks(deps)).toBe(0);
    setNow(T0 + 60_001);
    expect(await purgeDeletedLinks(deps)).toBe(1);
  });

  it("the link window equals the copy window", () => {
    expect(LINK_UNDO_WINDOW_MS).toBe(COPY_UNDO_WINDOW_MS);
  });
});

describe("a deleted link, through SQLite and core", () => {
  it("after deleteLink the link is gone from get, listLinks, search, count, digest, Handy, list_links and get_link", async () => {
    const deps = createDeps(openDatabase(":memory:"), new FakeEmbedder(DIMS));
    deps.store.ensureUser(OWNER, OWNER);
    const { link } = await saveLink(deps, OWNER, {
      url: "https://ex.com/quokka",
      title: "quokka",
      savedBy: "t",
    });
    await keepHandy(deps, OWNER, link.id, "stated");
    const before = await listLinks(deps, OWNER, {});
    expect(before.links.map((l) => l.id)).toContain(link.id);
    expect((await listShelf(deps, OWNER)).map((s) => s.link.id)).toEqual([link.id]);

    await deleteLink(deps, OWNER, link.id);

    await expect(getLinkWithText(deps, OWNER, link.id, "t")).rejects.toMatchObject({
      code: "not_found",
    });
    const after = await listLinks(deps, OWNER, {});
    expect(after.links.map((l) => l.id)).not.toContain(link.id);
    expect(after.total).toBe(before.total - 1);
    const found = await searchLinks(deps, OWNER, { query: "quokka" }, "t");
    expect(found.map((l) => l.id)).not.toContain(link.id);
    expect(await listShelf(deps, OWNER)).toEqual([]);
  });
});

describe("createLinkPurger", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the purger purges once at start and again each tick, and logs a failure without stopping", async () => {
    vi.useFakeTimers();
    const store = new FakeStore();
    const purge = vi
      .spyOn(store, "purgeDeleted")
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValue(0);
    const log = vi.fn();
    const purger = createLinkPurger({ store, now: () => new Date(T0), log });

    purger.start();
    expect(purge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe("link purge failed");

    purger.stop();
    purger.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(purge).toHaveBeenCalledTimes(2);
  });
});
