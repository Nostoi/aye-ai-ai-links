import { beforeEach, describe, expect, it } from "vitest";
import type { ProfileChanges, ProfileStore } from "./profile-store.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type ProfileHarness = {
  store: ProfileStore;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
};

export const A = "owner-a";
export const B = "owner-b";

export const changes = (c: Partial<ProfileChanges> = {}): ProfileChanges => ({
  addNotes: [],
  editNotes: [],
  removeNotes: [],
  addFocus: [],
  ...c,
});

const T1 = new Date("2026-01-01T00:00:00Z");
const T2 = new Date("2026-02-02T00:00:00Z");
const LIMIT = 10;

export function describeProfileStoreContract(
  name: string,
  makeHarness: () => ProfileHarness | Promise<ProfileHarness>,
): void {
  describe(name, () => {
    let store: ProfileStore;

    const apply = (
      owner: string,
      c: Partial<ProfileChanges>,
      writtenBy = "claude-code",
      at = T1,
      focusLimit = LIMIT,
    ) => store.apply(owner, changes(c), { writtenBy, at, focusLimit });

    /** Apply a change that must succeed. */
    async function applyOk(
      owner: string,
      c: Partial<ProfileChanges>,
      writtenBy?: string,
      at?: Date,
    ) {
      const r = await apply(owner, c, writtenBy, at);
      if (!r.ok) throw new Error(`expected ok, got unknown id ${r.unknownId}`);
      return r;
    }

    beforeEach(async () => {
      const h = await makeHarness();
      store = h.store;
      await h.addOwner(A);
      await h.addOwner(B);
    });

    it("keeps an inferred note's label, writer and time, and lists notes oldest first", async () => {
      await applyOk(A, { addNotes: [{ text: "likes long reads", source: "inferred" }] }, "codex");
      await applyOk(A, { addNotes: [{ text: "plans a battery install", source: "stated" }] });
      const notes = await store.listNotes(A);
      expect(notes).toEqual([
        {
          id: expect.any(String),
          text: "likes long reads",
          source: "inferred",
          writtenBy: "codex",
          updatedAt: T1,
        },
        {
          id: expect.any(String),
          text: "plans a battery install",
          source: "stated",
          writtenBy: "claude-code",
          updatedAt: T1,
        },
      ]);
      expect(Number(notes[0]?.id)).toBeLessThan(Number(notes[1]?.id));
    });

    it("keeps a focus entry's label, writer and time", async () => {
      await applyOk(
        A,
        { addFocus: [{ text: "reading about heat pumps", source: "inferred" }] },
        "codex",
        T2,
      );
      expect(await store.recentFocus(A, LIMIT)).toEqual([
        {
          id: expect.any(String),
          text: "reading about heat pumps",
          source: "inferred",
          writtenBy: "codex",
          createdAt: T2,
        },
      ]);
    });

    it("returns an owner with nothing as empty lists", async () => {
      expect(await store.listNotes("nobody")).toEqual([]);
      expect(await store.recentFocus("nobody", LIMIT)).toEqual([]);
    });

    it("returns the committed profile and the new ids from the write itself", async () => {
      await applyOk(A, { addNotes: [{ text: "old", source: "stated" }] });
      const r = await applyOk(
        A,
        {
          addNotes: [
            { text: "n1", source: "asked" },
            { text: "n2", source: "inferred" },
          ],
          addFocus: [{ text: "f1", source: "stated" }],
        },
        "claude-code",
        T2,
      );
      expect(r.notes).toEqual(await store.listNotes(A));
      expect(r.recentFocus).toEqual(await store.recentFocus(A, LIMIT));
      expect(r.addedNoteIds).toHaveLength(2);
      expect(r.addedNoteIds.map((id) => r.notes.find((n) => n.id === id)?.text)).toEqual([
        "n1",
        "n2",
      ]);
      expect(r.addedFocusIds).toEqual(r.recentFocus.map((f) => f.id));
    });

    it("limits the focus it returns from a write to focusLimit", async () => {
      const r = await store.apply(
        A,
        changes({
          addFocus: [
            { text: "f1", source: "stated" },
            { text: "f2", source: "stated" },
            { text: "f3", source: "stated" },
          ],
        }),
        { writtenBy: "x", at: T1, focusLimit: 2 },
      );
      if (!r.ok) throw new Error("expected ok");
      expect(r.recentFocus.map((f) => f.text)).toEqual(["f3", "f2"]);
      expect(r.addedFocusIds).toHaveLength(3);
    });

    it("edits replace text and source and restamp the writer and time", async () => {
      const added = await applyOk(A, {
        addNotes: [{ text: "wants a heat pump", source: "stated" }],
      });
      const id = added.addedNoteIds[0] as string;
      const r = await applyOk(
        A,
        { editNotes: [{ id, text: "maybe wants a heat pump", source: "inferred" }] },
        "codex",
        T2,
      );
      expect(r.notes).toEqual([
        {
          id,
          text: "maybe wants a heat pump",
          source: "inferred",
          writtenBy: "codex",
          updatedAt: T2,
        },
      ]);
      expect(await store.listNotes(A)).toEqual(r.notes);
    });

    it("removes a note", async () => {
      const added = await applyOk(A, {
        addNotes: [
          { text: "keep", source: "stated" },
          { text: "drop", source: "stated" },
        ],
      });
      const r = await applyOk(A, { removeNotes: [added.addedNoteIds[1] as string] });
      expect(r.notes.map((n) => n.text)).toEqual(["keep"]);
    });

    it("never issues the id of a removed note again", async () => {
      const first = await applyOk(A, { addNotes: [{ text: "one", source: "stated" }] });
      const second = await applyOk(A, { addNotes: [{ text: "two", source: "stated" }] });
      const highest = second.addedNoteIds[0] as string;
      await applyOk(A, { removeNotes: [highest] });
      const third = await applyOk(A, { addNotes: [{ text: "three", source: "stated" }] });
      expect(third.addedNoteIds[0]).not.toBe(highest);
      expect(third.addedNoteIds[0]).not.toBe(first.addedNoteIds[0]);
      const late = await apply(A, {
        editNotes: [{ id: highest, text: "late edit", source: "stated" }],
      });
      expect(late).toEqual({ ok: false, unknownId: highest });
      expect((await store.listNotes(A)).map((n) => n.text)).toEqual(["one", "three"]);
    });

    it("refuses another owner's note id on edit and on remove, and changes nothing", async () => {
      const b = await applyOk(
        B,
        { addNotes: [{ text: "b's note", source: "stated" }] },
        "codex",
        T1,
      );
      const x = b.addedNoteIds[0] as string;
      const before = await store.listNotes(B);
      expect(
        await apply(A, { editNotes: [{ id: x, text: "hijack", source: "inferred" }] }, "evil", T2),
      ).toEqual({
        ok: false,
        unknownId: x,
      });
      expect(await apply(A, { removeNotes: [x] })).toEqual({ ok: false, unknownId: x });
      expect(await store.listNotes(B)).toEqual(before);
      expect(await store.listNotes(A)).toEqual([]);
    });

    it("applies nothing when any edit or remove id is unknown", async () => {
      const added = await applyOk(A, { addNotes: [{ text: "n1", source: "stated" }] });
      const n1 = added.addedNoteIds[0] as string;
      const before = await store.listNotes(A);
      const result = await apply(
        A,
        {
          addNotes: [{ text: "new", source: "stated" }],
          editNotes: [{ id: n1, text: "changed", source: "stated" }],
          removeNotes: ["999"],
          addFocus: [{ text: "f", source: "stated" }],
        },
        "codex",
        T2,
      );
      expect(result).toEqual({ ok: false, unknownId: "999" });
      expect(await store.listNotes(A)).toEqual(before);
      expect(await store.recentFocus(A, LIMIT)).toEqual([]);
    });

    it("applies nothing when an edit id is unknown, even after an earlier edit and remove would succeed", async () => {
      const added = await applyOk(A, {
        addNotes: [
          { text: "n1", source: "stated" },
          { text: "n2", source: "stated" },
        ],
      });
      const [n1, n2] = added.addedNoteIds as [string, string];
      const before = await store.listNotes(A);
      const result = await apply(A, {
        editNotes: [
          { id: n1, text: "changed", source: "stated" },
          { id: "999", text: "x", source: "stated" },
        ],
        removeNotes: [n2],
      });
      expect(result).toEqual({ ok: false, unknownId: "999" });
      expect(await store.listNotes(A)).toEqual(before);
    });

    it.each(["", "abc", "0", "01", "-1", "1.5", "99999999999999999999"])(
      "treats the never-issued id %j as absent, not as an error",
      async (id) => {
        expect(await apply(A, { removeNotes: [id] })).toEqual({ ok: false, unknownId: id });
        expect(await apply(A, { editNotes: [{ id, text: "x", source: "stated" }] })).toEqual({
          ok: false,
          unknownId: id,
        });
      },
    );

    it("returns the newest focus entries newest first, ties by id, and only the owner's", async () => {
      for (let k = 0; k < 10; k++) {
        await applyOk(
          A,
          { addFocus: [{ text: `f${k}`, source: "stated" }] },
          "x",
          new Date(T1.getTime() + k * 1000),
        );
      }
      await applyOk(
        A,
        {
          addFocus: [
            { text: "f10", source: "stated" },
            { text: "f11", source: "stated" },
          ],
        },
        "x",
        new Date(T1.getTime() + 10_000),
      );
      await applyOk(
        B,
        { addFocus: [{ text: "b-focus", source: "stated" }] },
        "x",
        new Date(T1.getTime() + 99_000),
      );
      const texts = (await store.recentFocus(A, LIMIT)).map((f) => f.text);
      expect(texts).toEqual(["f11", "f10", "f9", "f8", "f7", "f6", "f5", "f4", "f3", "f2"]);
      expect((await store.recentFocus(A, 3)).map((f) => f.text)).toEqual(["f11", "f10", "f9"]);
    });

    it("does nothing for an empty change and still returns the profile", async () => {
      await applyOk(A, { addNotes: [{ text: "n", source: "stated" }] });
      const r = await applyOk(A, {});
      expect(r.notes).toHaveLength(1);
      expect(r.addedNoteIds).toEqual([]);
      expect(r.addedFocusIds).toEqual([]);
    });
  });
}
