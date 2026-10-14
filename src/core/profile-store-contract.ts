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
const T3 = new Date("2026-03-03T00:00:00Z");
const LIMIT = 10;
/** A purge cutoff before every test time, so a write purges nothing. */
const NO_PURGE = new Date(0);

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
      purgeBefore = NO_PURGE,
    ) => store.apply(owner, changes(c), { writtenBy, at, focusLimit, purgeBefore });

    /** Apply a change that must succeed. */
    async function applyOk(
      owner: string,
      c: Partial<ProfileChanges>,
      writtenBy?: string,
      at?: Date,
      purgeBefore?: Date,
    ) {
      const r = await apply(owner, c, writtenBy, at, LIMIT, purgeBefore);
      if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
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
        { writtenBy: "x", at: T1, focusLimit: 2, purgeBefore: NO_PURGE },
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
        {
          editNotes: [
            { id, text: "maybe wants a heat pump", source: "inferred", expectedSource: "stated" },
          ],
        },
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
      const r = await applyOk(A, {
        removeNotes: [{ id: added.addedNoteIds[1] as string, expectedSource: "stated" }],
      });
      expect(r.notes.map((n) => n.text)).toEqual(["keep"]);
    });

    it("never issues the id of a removed note again", async () => {
      const first = await applyOk(A, { addNotes: [{ text: "one", source: "stated" }] });
      const second = await applyOk(A, { addNotes: [{ text: "two", source: "stated" }] });
      const highest = second.addedNoteIds[0] as string;
      await applyOk(A, { removeNotes: [{ id: highest, expectedSource: "stated" }] });
      const third = await applyOk(A, { addNotes: [{ text: "three", source: "stated" }] });
      expect(third.addedNoteIds[0]).not.toBe(highest);
      expect(third.addedNoteIds[0]).not.toBe(first.addedNoteIds[0]);
      const late = await apply(A, {
        editNotes: [{ id: highest, text: "late edit", source: "stated", expectedSource: "stated" }],
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
        await apply(
          A,
          { editNotes: [{ id: x, text: "hijack", source: "inferred", expectedSource: "stated" }] },
          "evil",
          T2,
        ),
      ).toEqual({
        ok: false,
        unknownId: x,
      });
      expect(await apply(A, { removeNotes: [{ id: x, expectedSource: "stated" }] })).toEqual({
        ok: false,
        unknownId: x,
      });
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
          editNotes: [{ id: n1, text: "changed", source: "stated", expectedSource: "stated" }],
          removeNotes: [{ id: "999", expectedSource: "stated" }],
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
          { id: n1, text: "changed", source: "stated", expectedSource: "stated" },
          { id: "999", text: "x", source: "stated", expectedSource: "stated" },
        ],
        removeNotes: [{ id: n2, expectedSource: "stated" }],
      });
      expect(result).toEqual({ ok: false, unknownId: "999" });
      expect(await store.listNotes(A)).toEqual(before);
    });

    it.each(["", "abc", "0", "01", "-1", "1.5", "99999999999999999999"])(
      "treats the never-issued id %j as absent, not as an error",
      async (id) => {
        expect(await apply(A, { removeNotes: [{ id, expectedSource: "stated" }] })).toEqual({
          ok: false,
          unknownId: id,
        });
        expect(
          await apply(A, {
            editNotes: [{ id, text: "x", source: "stated", expectedSource: "stated" }],
          }),
        ).toEqual({
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

    describe("when a note's source is no longer the one that was read", () => {
      async function seed() {
        const added = await applyOk(A, {
          addNotes: [
            { text: "owner said", source: "stated" },
            { text: "agent guessed", source: "inferred" },
          ],
        });
        const [stated, guess] = added.addedNoteIds as [string, string];
        return { stated, guess, before: await store.listNotes(A) };
      }

      it("changes nothing and reports a conflict for an edit, rolling back the other ops", async () => {
        const { stated, guess, before } = await seed();
        const result = await apply(
          A,
          {
            addNotes: [{ text: "new", source: "stated" }],
            editNotes: [
              { id: guess, text: "guess, revised", source: "inferred", expectedSource: "inferred" },
              { id: stated, text: "overwritten", source: "inferred", expectedSource: "inferred" },
            ],
            addFocus: [{ text: "f", source: "stated" }],
          },
          "codex",
          T2,
        );
        expect(result).toEqual({ ok: false, conflictId: stated });
        expect(await store.listNotes(A)).toEqual(before);
        expect(await store.recentFocus(A, LIMIT)).toEqual([]);
      });

      it("changes nothing and reports a conflict for a remove, rolling back the other ops", async () => {
        const { stated, guess, before } = await seed();
        const result = await apply(
          A,
          {
            editNotes: [
              { id: guess, text: "guess, revised", source: "inferred", expectedSource: "inferred" },
            ],
            removeNotes: [{ id: stated, expectedSource: "inferred" }],
          },
          "codex",
          T2,
        );
        expect(result).toEqual({ ok: false, conflictId: stated });
        expect(await store.listNotes(A)).toEqual(before);
      });

      it("still reports an unknown id as unknown, not as a conflict", async () => {
        const { before } = await seed();
        const result = await apply(A, {
          removeNotes: [{ id: "999", expectedSource: "inferred" }],
        });
        expect(result).toEqual({ ok: false, unknownId: "999" });
        expect(await store.listNotes(A)).toEqual(before);
      });
    });

    describe("a removed note", () => {
      /** Three notes of A's, the middle one removed at T2; `before` is the list as it was. */
      async function removedMiddle() {
        const added = await applyOk(
          A,
          {
            addNotes: [
              { text: "first", source: "stated" },
              { text: "middle guess", source: "inferred" },
              { text: "last", source: "asked" },
            ],
          },
          "codex",
        );
        const [, middle] = added.addedNoteIds as [string, string, string];
        const before = await store.listNotes(A);
        await applyOk(A, { removeNotes: [{ id: middle, expectedSource: "inferred" }] }, "web", T2);
        return { middle, before };
      }

      it("is hidden from listNotes and from the write's result", async () => {
        const { middle } = await removedMiddle();
        expect((await store.listNotes(A)).map((n) => n.text)).toEqual(["first", "last"]);
        const r = await applyOk(A, {});
        expect(r.notes.map((n) => n.id)).not.toContain(middle);
      });

      it("answers unknownId to an edit or a second remove, and changes nothing", async () => {
        const { middle } = await removedMiddle();
        const shown = await store.listNotes(A);
        expect(
          await apply(A, {
            editNotes: [{ id: middle, text: "back", source: "stated", expectedSource: "inferred" }],
          }),
        ).toEqual({ ok: false, unknownId: middle });
        expect(
          await apply(A, { removeNotes: [{ id: middle, expectedSource: "inferred" }] }),
        ).toEqual({ ok: false, unknownId: middle });
        expect(await store.listNotes(A)).toEqual(shown);
        expect(await store.restoreNote(A, middle, T2)).toBe(true);
      });

      it("is restored unchanged, with its id, text, label, writer, time and place", async () => {
        const { middle, before } = await removedMiddle();
        expect(await store.restoreNote(A, middle, T2)).toBe(true);
        expect(await store.listNotes(A)).toEqual(before);
      });

      it("is not restored when it was removed before removedSince, and nothing changes", async () => {
        const { middle } = await removedMiddle();
        const shown = await store.listNotes(A);
        expect(await store.restoreNote(A, middle, new Date(T2.getTime() + 1))).toBe(false);
        expect(await store.listNotes(A)).toEqual(shown);
      });

      it("is restored only once", async () => {
        const { middle, before } = await removedMiddle();
        expect(await store.restoreNote(A, middle, T2)).toBe(true);
        expect(await store.restoreNote(A, middle, T2)).toBe(false);
        expect(await store.listNotes(A)).toEqual(before);
      });

      it.each(["", "abc", "0", "999"])("restores nothing for the id %j", async (id) => {
        await removedMiddle();
        const shown = await store.listNotes(A);
        expect(await store.restoreNote(A, id, NO_PURGE)).toBe(false);
        expect(await store.listNotes(A)).toEqual(shown);
      });

      it("is not restored for another owner, and stays restorable by its own", async () => {
        const { middle } = await removedMiddle();
        expect(await store.restoreNote(B, middle, NO_PURGE)).toBe(false);
        expect(await store.listNotes(B)).toEqual([]);
        expect(await store.restoreNote(A, middle, T2)).toBe(true);
      });

      it("is purged by the owner's next write once it was removed before purgeBefore", async () => {
        const { middle } = await removedMiddle();
        const kept = await applyOk(A, { addNotes: [{ text: "x", source: "stated" }] });
        const newer = kept.addedNoteIds[0] as string;
        await applyOk(A, { removeNotes: [{ id: newer, expectedSource: "stated" }] }, "web", T3);
        await applyOk(A, {}, "web", T3, new Date(T2.getTime() + 1));
        expect(await store.restoreNote(A, middle, NO_PURGE)).toBe(false);
        expect(await store.restoreNote(A, newer, NO_PURGE)).toBe(true);
      });

      it("is purged by a restore of another note, with the same cutoff as removedSince", async () => {
        const { middle } = await removedMiddle();
        const kept = await applyOk(A, { addNotes: [{ text: "x", source: "stated" }] });
        const newer = kept.addedNoteIds[0] as string;
        await applyOk(A, { removeNotes: [{ id: newer, expectedSource: "stated" }] }, "web", T3);
        expect(await store.restoreNote(A, newer, new Date(T2.getTime() + 1))).toBe(true);
        expect(await store.restoreNote(A, middle, NO_PURGE)).toBe(false);
      });

      it("is not purged by another owner's write", async () => {
        const { middle } = await removedMiddle();
        await applyOk(B, { addNotes: [{ text: "b", source: "stated" }] }, "x", T3, T3);
        await store.restoreNote(B, "999", T3);
        expect(await store.restoreNote(A, middle, NO_PURGE)).toBe(true);
      });
    });

    describe("a write that expects the note's updatedAt", () => {
      async function seed() {
        const added = await applyOk(A, { addNotes: [{ text: "a guess", source: "inferred" }] });
        const id = added.addedNoteIds[0] as string;
        return { id, before: await store.listNotes(A) };
      }

      it("applies an edit and a remove when the note's updatedAt is the one given", async () => {
        const { id } = await seed();
        await applyOk(
          A,
          {
            editNotes: [
              {
                id,
                text: "confirmed",
                source: "stated",
                expectedSource: "inferred",
                expectedUpdatedAt: T1,
              },
            ],
          },
          "web",
          T2,
        );
        expect((await store.listNotes(A))[0]).toMatchObject({ text: "confirmed", updatedAt: T2 });
        await applyOk(A, {
          removeNotes: [{ id, expectedSource: "stated", expectedUpdatedAt: T2 }],
        });
        expect(await store.listNotes(A)).toEqual([]);
      });

      it("answers conflict for an edit or a remove when it differs, and changes nothing", async () => {
        const { id, before } = await seed();
        const stale = new Date(T1.getTime() - 1);
        expect(
          await apply(
            A,
            {
              addNotes: [{ text: "new", source: "stated" }],
              editNotes: [
                {
                  id,
                  text: "x",
                  source: "stated",
                  expectedSource: "inferred",
                  expectedUpdatedAt: stale,
                },
              ],
            },
            "web",
            T2,
          ),
        ).toEqual({ ok: false, conflictId: id });
        expect(
          await apply(A, {
            removeNotes: [{ id, expectedSource: "inferred", expectedUpdatedAt: stale }],
          }),
        ).toEqual({ ok: false, conflictId: id });
        expect(await store.listNotes(A)).toEqual(before);
      });

      it("answers unknownId, not conflict, for another owner's note", async () => {
        const { id, before } = await seed();
        expect(
          await apply(B, {
            removeNotes: [{ id, expectedSource: "inferred", expectedUpdatedAt: T1 }],
          }),
        ).toEqual({ ok: false, unknownId: id });
        expect(await store.listNotes(A)).toEqual(before);
      });
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
