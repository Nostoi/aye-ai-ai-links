import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.js";
import { jpeg, png, svg } from "./image-test-kit.js";
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from "./image-type.js";
import { BAD_PICTURE, editLink, UNDO_CONFLICT, undoEdit } from "./link-edit.js";
import { updateLink } from "./links.js";
import { newLink } from "./snapshot-store-contract.js";
import { normalizeTags } from "./tags.js";

const T0 = new Date("2026-10-17T09:00:00Z");
const SHOT = png(64, 48, Buffer.from("a screenshot"));

async function setup(title: string | null = "Quokka habitat") {
  const store = new FakeStore();
  const deps = { store, edits: store, now: () => T0 };
  const { link } = await store.insertIfAbsent("a", { ...newLink(1, T0), title });
  return { store, deps, id: link.id };
}

describe("editLink", () => {
  it("writes the title through the one title rule: trimmed, blank to none", async () => {
    const { store, deps, id } = await setup();
    expect(await editLink(deps, "a", id, { title: "  Quokka burrows " })).toEqual(
      expect.any(String),
    );
    expect((await store.get("a", id))?.title).toBe("Quokka burrows");
    await editLink(deps, "a", id, { title: "  " });
    expect((await store.get("a", id))?.title).toBeNull();
  });

  it("stores the type the picture's own header names", async () => {
    const { store, deps, id } = await setup();
    await editLink(deps, "a", id, { picture: new Uint8Array(jpeg(40, 30)) });
    expect((await store.image("a", id))?.contentType).toBe("image/jpeg");
  });

  it.each([
    ["an SVG", svg],
    ["2 MiB + 1 byte", Buffer.concat([SHOT, Buffer.alloc(MAX_IMAGE_BYTES + 1 - SHOT.length)])],
    ["a header over the pixel cap", png(MAX_IMAGE_PIXELS / 4000 + 1, 4000)],
  ])(
    "refuses %s as invalid_input in the owner's words, writing nothing, title included",
    async (_, bytes) => {
      const { store, deps, id } = await setup();
      await expect(
        editLink(deps, "a", id, { title: "Changed", picture: new Uint8Array(bytes) }),
      ).rejects.toMatchObject({ code: "invalid_input", message: BAD_PICTURE });
      expect((await store.get("a", id))?.title).toBe("Quokka habitat");
      expect(await store.image("a", id)).toBeNull();
    },
  );

  it("refuses a 201-character title, writing nothing, picture included", async () => {
    const { store, deps, id } = await setup();
    await expect(
      editLink(deps, "a", id, { title: "a".repeat(201), picture: new Uint8Array(SHOT) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await store.image("a", id)).toBeNull();
  });

  it("leaves a stored 201-character title as it was on a picture-only edit", async () => {
    const long = "b".repeat(201);
    const { store, deps, id } = await setup(long);
    expect(await editLink(deps, "a", id, { picture: new Uint8Array(SHOT) })).toEqual(
      expect.any(String),
    );
    expect((await store.get("a", id))?.title).toBe(long);
  });

  it("returns no edit id when nothing would change", async () => {
    const { deps, id } = await setup();
    expect(await editLink(deps, "a", id, { title: " Quokka habitat " })).toBeNull();
    expect(await editLink(deps, "a", id, { picture: "page" })).toBeNull();
  });

  it("answers another owner's link as not_found, and A's link stays", async () => {
    const { store, deps, id } = await setup();
    await expect(editLink(deps, "b", id, { title: "B's" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await store.get("a", id))?.title).toBe("Quokka habitat");
  });
});

describe("editLink with tags", () => {
  const seenOf = (tags: { key: string; source: string }[]) =>
    tags.map(({ key, source }) => ({ key, source }));
  const keysOf = async (store: FakeStore, id: string) =>
    (await store.get("a", id))?.tags.map((t) => [t.key, t.source]);
  async function tagged() {
    const s = await setup();
    await s.store.update("a", s.id, {
      tags: normalizeTags([
        { name: "Guess", source: "inferred" },
        { name: "Mine", source: "asked" },
      ]),
    });
    const seen = seenOf((await s.store.get("a", s.id))?.tags ?? []);
    return { ...s, seen };
  }

  it("writes the names in order: a kept tag keeps its seen source, a new one is stated", async () => {
    const { store, deps, id, seen } = await tagged();
    await editLink(deps, "a", id, { tags: { names: ["mine", "New one", "Guess"], seen } });
    expect(await keysOf(store, id)).toEqual([
      ["mine", "asked"],
      ["new one", "stated"],
      ["guess", "inferred"],
    ]);
    expect((await store.get("a", id))?.tags[1]?.name).toBe("New one");
  });

  it("removing a tag and adding it back cancels out: no edit, the guess stays a guess", async () => {
    const { store, deps, id, seen } = await tagged();
    expect(await editLink(deps, "a", id, { tags: { names: ["Guess", "Mine"], seen } })).toBeNull();
    expect(await keysOf(store, id)).toEqual([
      ["guess", "inferred"],
      ["mine", "asked"],
    ]);
  });

  it("dedupes names by key", async () => {
    const { store, deps, id, seen } = await tagged();
    await editLink(deps, "a", id, { tags: { names: ["x", " X ", "y"], seen } });
    expect(await keysOf(store, id)).toEqual([
      ["x", "stated"],
      ["y", "stated"],
    ]);
  });

  it("refuses a blank name as invalid_input, writing nothing", async () => {
    const { store, deps, id, seen } = await tagged();
    await expect(
      editLink(deps, "a", id, { title: "Changed", tags: { names: ["ok", "  "], seen } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect((await store.get("a", id))?.title).toBe("Quokka habitat");
    expect(await keysOf(store, id)).toHaveLength(2);
  });

  it("refuses a seen source that is not a source as invalid_input", async () => {
    const { deps, id } = await tagged();
    await expect(
      editLink(deps, "a", id, {
        tags: { names: ["a"], seen: [{ key: "guess", source: "bogus" }] },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("answers a link whose tags changed since the dialog opened as a conflict, writing nothing", async () => {
    const { store, deps, id, seen } = await tagged();
    await updateLink(deps, "a", id, { tags: [{ name: "agent", source: "inferred" }] });
    await expect(
      editLink(deps, "a", id, { title: "Changed", tags: { names: ["Guess", "z"], seen } }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This link's tags changed since you opened it. Reload the page and edit again.",
    });
    expect((await store.get("a", id))?.title).toBe("Quokka habitat");
    expect(await keysOf(store, id)).toEqual([["agent", "inferred"]]);
  });

  it("one Undo puts back the title, picture and the old tags with their sources", async () => {
    const { store, deps, id, seen } = await tagged();
    const edit = await editLink(deps, "a", id, {
      title: "New",
      picture: new Uint8Array(SHOT),
      tags: { names: ["only"], seen },
    });
    await undoEdit(deps, "a", id, edit as string);
    expect((await store.get("a", id))?.title).toBe("Quokka habitat");
    expect(await store.image("a", id)).toBeNull();
    expect(await keysOf(store, id)).toEqual([
      ["guess", "inferred"],
      ["mine", "asked"],
    ]);
  });
});

describe("undoEdit", () => {
  it("puts the edit back once; a second Undo is a conflict in the owner's words", async () => {
    const { store, deps, id } = await setup();
    const editId = (await editLink(deps, "a", id, {
      title: "New",
      picture: new Uint8Array(SHOT),
    })) as string;
    await undoEdit(deps, "a", id, editId);
    expect((await store.get("a", id))?.title).toBe("Quokka habitat");
    expect(await store.image("a", id)).toBeNull();
    await expect(undoEdit(deps, "a", id, editId)).rejects.toMatchObject({
      code: "conflict",
      message: UNDO_CONFLICT,
    });
  });

  it("conflicts after an agent's title change, keeping the agent's title", async () => {
    const { store, deps, id } = await setup();
    const editId = (await editLink(deps, "a", id, { title: "Mine" })) as string;
    await updateLink(deps, "a", id, { title: "Agent's" });
    await expect(undoEdit(deps, "a", id, editId)).rejects.toMatchObject({ code: "conflict" });
    expect((await store.get("a", id))?.title).toBe("Agent's");
  });

  it("answers another owner's link as not_found", async () => {
    const { deps, id } = await setup();
    const editId = (await editLink(deps, "a", id, { title: "Mine" })) as string;
    await expect(undoEdit(deps, "b", id, editId)).rejects.toMatchObject({ code: "not_found" });
  });
});
