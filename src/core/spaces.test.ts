import { beforeEach, describe, expect, it } from "vitest";
import { CoreError } from "./errors.js";
import { FakeSearch } from "./fake-search.js";
import { FakeStore } from "./fake-store.js";
import { saveLink } from "./links.js";
import { homeSpaces, openSpace } from "./spaces.js";

let store: FakeStore;
let withImage: Set<string>;
let clock: number;

/** Images stand in for stored ones: each link in `withImage` has version `v-<id>`. */
const deps = () => ({
  store,
  search: new FakeSearch(store),
  images: {
    imageVersions: async (_owner: string, ids: string[]) =>
      new Map(
        ids
          .filter((id) => withImage.has(id))
          .map((id) => [id, { version: `v-${id}`, fit: "cover" as const }]),
      ),
  },
});

const save = async (owner: string, tags: string[], { image = false } = {}) => {
  const { link } = await saveLink({ store, now: () => new Date(clock++) }, owner, {
    url: `https://ex.com/${clock}`,
    savedBy: "t",
    tags: tags.map((name) => ({ name, source: "stated" as const })),
  });
  if (image) withImage.add(link.id);
  return link.id;
};

const pin = (owner: string, key: string, color: string) =>
  store.pinTag(owner, key, { pinned: true, color });

beforeEach(() => {
  store = new FakeStore();
  withImage = new Set();
  clock = 1_000;
});

describe("homeSpaces", () => {
  const shape = (spaces: Awaited<ReturnType<typeof homeSpaces>>["spaces"]) =>
    spaces.map(({ recent, ...s }) => ({ ...s, recent: recent.map((l) => l.id) }));

  it("lists only pinned tags, by key, each with its name, color and recent links", async () => {
    const both = await save("a", ["Kitchen", "Baking", "Home batteries"]);
    await pin("a", "kitchen", "clay");
    await pin("a", "home batteries", "teal");
    expect(shape((await homeSpaces(deps(), "a")).spaces)).toEqual([
      { key: "home batteries", name: "Home batteries", color: "teal", recent: [both] },
      { key: "kitchen", name: "Kitchen", color: "clay", recent: [both] },
    ]);
  });

  it("is empty when nothing is pinned, and never shows another owner's space", async () => {
    await save("a", ["Kitchen"]);
    await save("b", ["Kitchen"]);
    await pin("b", "kitchen", "violet");
    const { spaces, catalog } = await homeSpaces(deps(), "a");
    expect(spaces).toEqual([]);
    expect(catalog).toEqual([expect.objectContaining({ key: "kitchen", pinned: false })]);
  });

  it("gives each space its three newest active links, newest first, and only the owner's", async () => {
    await save("a", ["kitchen"]);
    const third = await save("a", ["kitchen"]);
    const second = await save("a", ["kitchen"]);
    const done = await save("a", ["kitchen"]);
    await store.update("a", done, { state: "archived" });
    await save("a", ["garden"]);
    const newest = await save("a", ["kitchen"]);
    await save("b", ["kitchen"]);
    await pin("a", "kitchen", "clay");
    await pin("b", "kitchen", "clay");
    const [kitchen] = (await homeSpaces(deps(), "a")).spaces;
    expect(kitchen?.recent.map((l) => l.id)).toEqual([newest, second, third]);
  });

  it("gives a space with no active links no recent links", async () => {
    const done = await save("a", ["kitchen"]);
    await store.update("a", done, { state: "archived" });
    await pin("a", "kitchen", "clay");
    expect((await homeSpaces(deps(), "a")).spaces[0]?.recent).toEqual([]);
  });

  it("gives a pinned tag whose stored color is not a space color no color", async () => {
    await save("a", ["kitchen"]);
    await pin("a", "kitchen", "amber");
    expect((await homeSpaces(deps(), "a")).spaces[0]).toMatchObject({
      key: "kitchen",
      color: null,
    });
  });
});

describe("openSpace", () => {
  it("opens any tag of the owner by its name, pinned or not, with its active links", async () => {
    const active = await save("a", ["Kitchen"]);
    const done = await save("a", ["Kitchen"]);
    await store.update("a", done, { state: "archived" });
    const space = await openSpace(deps(), "a", { name: "  KITCHEN ", state: "active", limit: 10 });
    expect(space.tag).toMatchObject({ key: "kitchen", name: "Kitchen", pinned: false });
    expect(space.catalog.map((t) => t.key)).toEqual(["kitchen"]);
    expect(space.page.links.map((l) => l.id)).toEqual([active]);
    const archived = await openSpace(deps(), "a", {
      name: "kitchen",
      state: "archived",
      limit: 10,
    });
    expect(archived.page.links.map((l) => l.id)).toEqual([done]);
  });

  it("lists a space oldest first and by recent opening, only opened links, and refuses another order's cursor", async () => {
    const first = await save("a", ["kitchen"]);
    const second = await save("a", ["kitchen"]);
    const third = await save("a", ["kitchen"]);
    await store.update("a", first, { lastOpenedAt: new Date(9_000) });
    await store.update("a", third, { lastOpenedAt: new Date(8_000) });
    const open = (order: "newest" | "oldest" | "opened", limit = 10, before?: string) =>
      openSpace(deps(), "a", {
        name: "kitchen",
        state: "active",
        limit,
        order,
        ...(before === undefined ? {} : { before }),
      });
    const ids = async (order: "newest" | "oldest" | "opened") =>
      (await open(order)).page.links.map((l) => l.id);
    expect(await ids("newest")).toEqual([third, second, first]);
    expect(await ids("oldest")).toEqual([first, second, third]);
    expect(await ids("opened")).toEqual([first, third]);
    const older = (await open("oldest", 1)).page.older as string;
    expect(older).not.toBeNull();
    const refusal = await open("newest", 1, older).catch((e: unknown) => e);
    expect((refusal as CoreError).code).toBe("invalid_input");
  });

  it("refuses an unknown key and another owner's key the same way", async () => {
    await save("a", ["kitchen"]);
    await save("b", ["Pantry"]);
    for (const name of ["garden", "pantry"]) {
      const refusal = await openSpace(deps(), "a", { name, state: "active", limit: 10 }).catch(
        (e: unknown) => e,
      );
      expect(refusal).toBeInstanceOf(CoreError);
      expect((refusal as CoreError).code).toBe("not_found");
      expect((refusal as CoreError).message).not.toContain(name);
    }
  });
});
