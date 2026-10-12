import { beforeEach, describe, expect, it } from "vitest";
import { FakeProfileStore } from "./fake-profile-store.js";
import { FakeStore } from "./fake-store.js";
import { filingContext } from "./filing-context.js";
import {
  addProfile,
  editProfile,
  getProfile,
  MAX_FOCUS_CHARS,
  MAX_NOTE_CHARS,
  profileContext,
  RECENT_FOCUS,
  recentFocus,
} from "./profile.js";
import type { ProfileStore } from "./profile-store.js";
import { A, B, describeProfileStoreContract } from "./profile-store-contract.js";
import type { Source, Tag } from "./types.js";

describeProfileStoreContract("FakeProfileStore", () => ({
  store: new FakeProfileStore(),
  addOwner: () => {},
}));

const NOW = new Date("2026-10-11T12:00:00Z");
const W = "claude-code";

async function code(p: Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await p;
  } catch (e) {
    return e as { code: string; message: string };
  }
  return null;
}

const tag = (key: string, over: Partial<Tag> = {}): Tag => ({
  key,
  name: key,
  kind: "topic",
  color: null,
  pinned: false,
  description: null,
  projectStatus: null,
  ...over,
});

describe("profile use cases", () => {
  let profile: FakeProfileStore;
  let deps: { profile: ProfileStore; now: () => Date };
  const addNote = async (text: string, source: Source = "stated", owner = A) =>
    (await addProfile(deps, owner, W, { addNotes: [{ text, source }] })).addedNoteIds[0] as string;
  const notes = (owner = A) => profile.listNotes(owner);

  beforeEach(() => {
    profile = new FakeProfileStore();
    deps = { profile, now: () => NOW };
  });

  describe("recent focus", () => {
    it("is the newest RECENT_FOCUS entries, newest first, for both recentFocus and profileContext", async () => {
      for (let k = 0; k < RECENT_FOCUS + 2; k++) {
        await addProfile({ profile, now: () => new Date(NOW.getTime() + k * 1000) }, A, W, {
          addFocus: [{ text: `f${k}`, source: "stated" }],
        });
      }
      const top = (await recentFocus(deps, A)).map((f) => f.text);
      expect(top).toHaveLength(RECENT_FOCUS);
      expect(top[0]).toBe(`f${RECENT_FOCUS + 1}`);
      expect((await profileContext(deps, A)).recentFocus.map((f) => f.text)).toEqual(top);
      expect((await profileContext(deps, A)).notes).toEqual([]);
    });
  });

  describe("getProfile", () => {
    it("reports active projects by the same rule as filingContext, with a done and a bare project", async () => {
      const store = new FakeStore();
      store.seedTag(A, tag("zeta", { kind: "project", projectStatus: "active" }));
      store.seedTag(A, tag("old", { kind: "project", projectStatus: "done" }));
      store.seedTag(A, tag("bare", { kind: "project" }));
      store.seedTag(A, tag("topic"));
      await addNote("n");
      const got = await getProfile({ profile, store }, A);
      expect(got.activeProjects).toEqual((await filingContext({ store }, A)).activeProjects);
      expect(got.activeProjects.map((t) => t.key)).toEqual(["bare", "zeta"]);
      expect(got.notes.map((n) => n.text)).toEqual(["n"]);
    });
  });

  describe("addProfile", () => {
    it("trims text, stamps the writer and the clock, and returns the new ids", async () => {
      const r = await addProfile(deps, A, "codex", {
        addNotes: [{ text: "  likes long reads \n", source: "inferred" }],
        addFocus: [{ text: " battery install ", source: "stated" }],
      });
      expect(r.notes).toEqual([
        {
          id: r.addedNoteIds[0],
          text: "likes long reads",
          source: "inferred",
          writtenBy: "codex",
          updatedAt: NOW,
        },
      ]);
      expect(r.recentFocus[0]).toMatchObject({
        text: "battery install",
        writtenBy: "codex",
        createdAt: NOW,
      });
      expect(r.addedFocusIds).toEqual([r.recentFocus[0]?.id]);
    });

    it("refuses an add with nothing to apply, names edit_profile, and writes nothing", async () => {
      for (const input of [{}, { addNotes: [], addFocus: [] }]) {
        const e = await code(addProfile(deps, A, W, input));
        expect(e?.code).toBe("invalid_input");
        expect(e?.message).toContain("edit_profile");
      }
      expect(await notes()).toEqual([]);
      expect(await recentFocus(deps, A)).toEqual([]);
    });

    it("refuses blank text and invalid sources and writes nothing", async () => {
      const bad = [
        {
          addNotes: [
            { text: "ok", source: "stated" as const },
            { text: "   ", source: "stated" as const },
          ],
        },
        { addFocus: [{ text: "", source: "stated" as const }] },
        { addNotes: [{ text: "ok", source: "guessed" as unknown as Source }] },
        { addFocus: [{ text: "ok", source: "guessed" as unknown as Source }] },
      ];
      for (const input of bad) {
        expect((await code(addProfile(deps, A, W, input)))?.code).toBe("invalid_input");
      }
      expect(await notes()).toEqual([]);
      expect(await recentFocus(deps, A)).toEqual([]);
    });

    it("accepts a note of exactly the cap and refuses one longer, without truncating or writing", async () => {
      await addNote("x".repeat(MAX_NOTE_CHARS));
      const err = await code(
        addProfile(deps, A, W, {
          addNotes: [{ text: "y".repeat(MAX_NOTE_CHARS + 1), source: "stated" }],
        }),
      );
      expect(err?.code).toBe("invalid_input");
      expect(err?.message).toContain(String(MAX_NOTE_CHARS));
      const stored = await notes();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.text).toHaveLength(MAX_NOTE_CHARS);
    });

    it("counts characters after trimming, not padding", async () => {
      await addNote(`  ${"x".repeat(MAX_NOTE_CHARS)}  `);
      expect((await notes())[0]?.text).toHaveLength(MAX_NOTE_CHARS);
    });

    it("accepts a focus entry of exactly the cap and refuses one longer, writing none of the call", async () => {
      await addProfile(deps, A, W, {
        addFocus: [{ text: "z".repeat(MAX_FOCUS_CHARS), source: "stated" }],
      });
      const err = await code(
        addProfile(deps, A, W, {
          addNotes: [{ text: "fine", source: "stated" }],
          addFocus: [{ text: "z".repeat(MAX_FOCUS_CHARS + 1), source: "stated" }],
        }),
      );
      expect(err?.code).toBe("invalid_input");
      expect(err?.message).toContain(String(MAX_FOCUS_CHARS));
      expect(await recentFocus(deps, A)).toHaveLength(1);
      expect(await notes()).toEqual([]);
    });

    it("returns its result from the write itself: failing reads afterwards cannot make a committed write fail", async () => {
      const readsFail: ProfileStore = {
        apply: (...args) => profile.apply(...args),
        listNotes: async () => {
          throw new Error("read after write");
        },
        recentFocus: async () => {
          throw new Error("read after write");
        },
      };
      const r = await addProfile({ profile: readsFail, now: () => NOW }, A, W, {
        addNotes: [{ text: "n", source: "stated" }],
        addFocus: [{ text: "f", source: "stated" }],
      });
      expect(r.notes.map((n) => n.text)).toEqual(["n"]);
      expect(r.recentFocus.map((f) => f.text)).toEqual(["f"]);
      expect(await notes()).toHaveLength(1);
    });
  });

  describe("editProfile", () => {
    it("replaces text and source, restamps the writer, and trims", async () => {
      const id = await addNote("a guess", "inferred");
      const r = await editProfile(
        { profile, now: () => new Date("2026-11-01T00:00:00Z") },
        A,
        "codex",
        {
          editNotes: [{ id, text: "  confirmed  ", source: "asked" }],
        },
      );
      expect(r.notes).toEqual([
        {
          id,
          text: "confirmed",
          source: "asked",
          writtenBy: "codex",
          updatedAt: new Date("2026-11-01T00:00:00Z"),
        },
      ]);
    });

    it("answers not_found for an unknown id, naming get_profile, and changes nothing", async () => {
      const id = await addNote("n");
      const err = await code(
        editProfile(deps, A, W, {
          editNotes: [{ id, text: "changed", source: "stated" }],
          removeNotes: ["999"],
        }),
      );
      expect(err?.code).toBe("not_found");
      expect(err?.message).toContain('"999"');
      expect(err?.message).toContain("get_profile");
      expect((await notes())[0]?.text).toBe("n");
    });

    it("refuses another owner's note as not_found", async () => {
      const id = await addNote("b's", "stated", B);
      expect((await code(editProfile(deps, A, W, { removeNotes: [id] })))?.code).toBe("not_found");
      expect(await notes(B)).toHaveLength(1);
    });

    it("refuses an inferred edit of a stated note, says to add a separate note, and leaves it unchanged", async () => {
      const id = await addNote("lives in Leeds", "stated");
      const err = await code(
        editProfile(deps, A, "codex", {
          editNotes: [{ id, text: "lives in York", source: "inferred" }],
        }),
      );
      expect(err?.code).toBe("invalid_input");
      expect(err?.message).toContain("stated");
      expect(err?.message).toMatch(/add_profile/);
      expect(await notes()).toEqual([
        { id, text: "lives in Leeds", source: "stated", writtenBy: W, updatedAt: NOW },
      ]);
    });

    it("refuses an asked edit of a stated note too, and writes none of the other edits in the call", async () => {
      const stated = await addNote("stated one", "stated");
      const guess = await addNote("guess", "inferred");
      const err = await code(
        editProfile(deps, A, W, {
          editNotes: [
            { id: guess, text: "changed guess", source: "inferred" },
            { id: stated, text: "x", source: "asked" },
          ],
        }),
      );
      expect(err?.code).toBe("invalid_input");
      expect((await notes()).map((n) => n.text)).toEqual(["stated one", "guess"]);
    });

    it("lets a stated edit change a stated note, and any source change an asked or inferred one", async () => {
      const s = await addNote("s", "stated");
      const a = await addNote("a", "asked");
      const i = await addNote("i", "inferred");
      await editProfile(deps, A, W, {
        editNotes: [
          { id: s, text: "s2", source: "stated" },
          { id: a, text: "a2", source: "inferred" },
          { id: i, text: "i2", source: "stated" },
        ],
      });
      expect((await notes()).map((n) => [n.text, n.source])).toEqual([
        ["s2", "stated"],
        ["a2", "inferred"],
        ["i2", "stated"],
      ]);
    });

    it("can remove a stated note (the tool description requires the owner's instruction)", async () => {
      const id = await addNote("s", "stated");
      await editProfile(deps, A, W, { removeNotes: [id] });
      expect(await notes()).toEqual([]);
    });

    it("answers conflict, without retrying, when a note it meant to remove became stated after it was read", async () => {
      const id = await addNote("probably York", "inferred");
      let applies = 0;
      let reads = 0;
      const racing: ProfileStore = {
        listNotes: async (owner) => {
          const seen = await profile.listNotes(owner);
          if (reads++ === 0) {
            await profile.apply(
              owner,
              {
                addNotes: [],
                editNotes: [
                  { id, text: "lives in Leeds", source: "stated", expectedSource: "inferred" },
                ],
                removeNotes: [],
                addFocus: [],
              },
              { writtenBy: "claude", at: NOW, focusLimit: RECENT_FOCUS },
            );
          }
          return seen;
        },
        apply: (...args) => {
          applies++;
          return profile.apply(...args);
        },
        recentFocus: (...args) => profile.recentFocus(...args),
      };
      const err = await code(
        editProfile({ profile: racing, now: () => NOW }, A, W, { removeNotes: [id] }),
      );
      expect(err?.code).toBe("conflict");
      expect(err?.message).toContain("get_profile");
      expect(applies).toBe(1);
      expect(await notes()).toEqual([
        { id, text: "lives in Leeds", source: "stated", writtenBy: "claude", updatedAt: NOW },
      ]);
    });

    it("refuses blank or over-long edit text, bad sources, and an id used twice, writing nothing", async () => {
      const id = await addNote("keep");
      const other = await addNote("other", "inferred");
      const bad = [
        { editNotes: [{ id, text: " ", source: "stated" as const }] },
        { editNotes: [{ id, text: "x".repeat(MAX_NOTE_CHARS + 1), source: "stated" as const }] },
        { editNotes: [{ id: other, text: "ok", source: "guessed" as unknown as Source }] },
        {
          editNotes: [{ id: other, text: "ok", source: "inferred" as const }],
          removeNotes: [other],
        },
        {
          editNotes: [
            { id: other, text: "one", source: "inferred" as const },
            { id: other, text: "two", source: "inferred" as const },
          ],
        },
        { removeNotes: [other, other] },
      ];
      for (const input of bad) {
        expect((await code(editProfile(deps, A, W, input)))?.code).toBe("invalid_input");
      }
      expect((await notes()).map((n) => n.text)).toEqual(["keep", "other"]);
    });

    it("refuses an edit with nothing to apply, names add_profile, and changes nothing", async () => {
      await addNote("n");
      for (const input of [{}, { editNotes: [], removeNotes: [] }]) {
        const e = await code(editProfile(deps, A, W, input));
        expect(e?.code).toBe("invalid_input");
        expect(e?.message).toContain("add_profile");
      }
      expect((await notes()).map((n) => n.text)).toEqual(["n"]);
    });

    describe("when the note's source changes between the read and the write", () => {
      /** A store whose first `flips` reads are each followed by a write that lands before core's apply. */
      function racing(flips: number, change: (id: string, seen: Source) => Source) {
        let reads = 0;
        let applies = 0;
        const stub: ProfileStore = {
          recentFocus: (o, l) => profile.recentFocus(o, l),
          listNotes: async (o) => {
            const seen = await profile.listNotes(o);
            if (reads++ < flips) {
              const n = seen[0] as (typeof seen)[number];
              await profile.apply(
                o,
                {
                  addNotes: [],
                  addFocus: [],
                  removeNotes: [],
                  editNotes: [
                    {
                      id: n.id,
                      text: n.text,
                      source: change(n.id, n.source),
                      expectedSource: n.source,
                    },
                  ],
                },
                { writtenBy: "owner", at: NOW, focusLimit: RECENT_FOCUS },
              );
            }
            return seen;
          },
          apply: (...args) => {
            applies++;
            return profile.apply(...args);
          },
        };
        return { stub, counts: () => ({ reads, applies }) };
      }

      it("answers conflict, applying once, when an inferred edit's note became stated, and keeps the stated note", async () => {
        const id = await addNote("lives in York", "inferred");
        const { stub, counts } = racing(1, () => "stated");
        const err = await code(
          editProfile({ ...deps, profile: stub }, A, "codex", {
            editNotes: [{ id, text: "lives in York, guessed", source: "inferred" }],
          }),
        );
        expect(err?.code).toBe("conflict");
        expect(err?.message).toContain("get_profile");
        expect(counts()).toEqual({ reads: 1, applies: 1 });
        expect(await notes()).toEqual([
          { id, text: "lives in York", source: "stated", writtenBy: "owner", updatedAt: NOW },
        ]);
      });

      it("keeps a note the owner made stated when a mixed edit and removal both raced", async () => {
        const editId = await addNote("edit me", "inferred");
        const removeId = await addNote("remove me", "inferred");
        let reads = 0;
        let applies = 0;
        const flip = (id: string, text: string, source: Source) =>
          profile.apply(
            A,
            {
              addNotes: [],
              addFocus: [],
              removeNotes: [],
              editNotes: [{ id, text, source, expectedSource: "inferred" }],
            },
            { writtenBy: "owner", at: NOW, focusLimit: RECENT_FOCUS },
          );
        const stub: ProfileStore = {
          recentFocus: (o, l) => profile.recentFocus(o, l),
          listNotes: async (o) => {
            const seen = await profile.listNotes(o);
            if (reads++ === 0) {
              await flip(editId, "edit me", "asked");
              await flip(removeId, "OWNER", "stated");
            }
            return seen;
          },
          apply: (...args) => {
            applies++;
            return profile.apply(...args);
          },
        };
        const err = await code(
          editProfile({ ...deps, profile: stub }, A, "codex", {
            editNotes: [{ id: editId, text: "guessed", source: "inferred" }],
            removeNotes: [removeId],
          }),
        );
        expect(err?.code).toBe("conflict");
        expect(applies).toBe(1);
        expect(await notes()).toEqual([
          { id: editId, text: "edit me", source: "asked", writtenBy: "owner", updatedAt: NOW },
          { id: removeId, text: "OWNER", source: "stated", writtenBy: "owner", updatedAt: NOW },
        ]);
      });

      it("answers conflict after a single apply when the edit's note changed source", async () => {
        const id = await addNote("lives in York", "inferred");
        const { stub, counts } = racing(2, (_id, seen) =>
          seen === "inferred" ? "asked" : "inferred",
        );
        const err = await code(
          editProfile({ ...deps, profile: stub }, A, "codex", {
            editNotes: [{ id, text: "lives in York, guessed", source: "inferred" }],
          }),
        );
        expect(err?.code).toBe("conflict");
        expect(err?.message).toContain("get_profile");
        expect(counts()).toEqual({ reads: 1, applies: 1 });
        expect((await notes())[0]?.text).toBe("lives in York");
      });
    });
  });
});
