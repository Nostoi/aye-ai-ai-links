import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.js";
import { jpeg, png, svg } from "./image-test-kit.js";
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from "./image-type.js";
import { BAD_PICTURE, editLink, UNDO_CONFLICT, undoEdit } from "./link-edit.js";
import { updateLink } from "./links.js";
import { newLink } from "./snapshot-store-contract.js";

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
