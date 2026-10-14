import { beforeEach, describe, expect, it } from "vitest";
import { CoreError } from "./errors.js";
import { FakeSearch } from "./fake-search.js";
import { FakeStore } from "./fake-store.js";
import { saveLink } from "./links.js";
import { homeSpaces, MOSAIC_DEPTH, openSpace } from "./spaces.js";

let store: FakeStore;
let withImage: Set<string>;
let clock: number;

/** Images stand in for stored ones: each link in `withImage` has version `v-<id>`. */
const deps = () => ({
  store,
  search: new FakeSearch(store),
  images: {
    imageVersions: async (_owner: string, ids: string[]) =>
      new Map(ids.filter((id) => withImage.has(id)).map((id) => [id, `v-${id}`])),
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
  it("lists only pinned tags, by key, each with its name and color", async () => {
    await save("a", ["Kitchen", "Baking", "Home batteries"]);
    await pin("a", "kitchen", "clay");
    await pin("a", "home batteries", "teal");
    expect(await homeSpaces(deps(), "a")).toEqual([
      { key: "home batteries", name: "Home batteries", color: "teal", mosaic: [] },
      { key: "kitchen", name: "Kitchen", color: "clay", mosaic: [] },
    ]);
  });

  it("is empty when nothing is pinned, and never shows another owner's space", async () => {
    await save("a", ["Kitchen"]);
    await save("b", ["Kitchen"]);
    await pin("b", "kitchen", "violet");
    expect(await homeSpaces(deps(), "a")).toEqual([]);
  });

  it("shows the three newest stored images of the space's active links", async () => {
    const oldest = await save("a", ["kitchen"], { image: true });
    const second = await save("a", ["kitchen"], { image: true });
    await save("a", ["kitchen"]);
    const third = await save("a", ["kitchen"], { image: true });
    const done = await save("a", ["kitchen"], { image: true });
    await store.update("a", done, { state: "archived" });
    await save("a", ["garden"], { image: true });
    const newest = await save("a", ["kitchen"], { image: true });
    await pin("a", "kitchen", "clay");
    const [kitchen] = await homeSpaces(deps(), "a");
    expect(kitchen?.mosaic).toEqual([
      { linkId: newest, version: `v-${newest}` },
      { linkId: third, version: `v-${third}` },
      { linkId: second, version: `v-${second}` },
    ]);
    expect(kitchen?.mosaic.map((m) => m.linkId)).not.toContain(oldest);
  });

  it(`looks for images among the newest ${MOSAIC_DEPTH} active links only`, async () => {
    await save("a", ["kitchen"], { image: true });
    for (let i = 0; i < MOSAIC_DEPTH; i++) await save("a", ["kitchen"]);
    await pin("a", "kitchen", "clay");
    expect((await homeSpaces(deps(), "a"))[0]?.mosaic).toEqual([]);
  });

  it("gives a pinned tag whose stored color is not a space color no color", async () => {
    await save("a", ["kitchen"]);
    await pin("a", "kitchen", "amber");
    expect((await homeSpaces(deps(), "a"))[0]).toMatchObject({ key: "kitchen", color: null });
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
