import { beforeEach, describe, expect, it } from "vitest";
import type { CoreError } from "./errors.js";
import { getLink, saveLink, updateLink } from "./links.js";
import type { LinkStore } from "./store.js";
import type { Labelled, Link, Tag } from "./types.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type StoreHarness = {
  store: LinkStore;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
  /** Every link the owner has, bypassing the LinkStore interface. */
  all(owner: string): MaybeAsync<Link[]>;
  /** The owner's tag catalog, in creation order. */
  catalog(owner: string): MaybeAsync<Tag[]>;
  seedTag(owner: string, tag: Tag): MaybeAsync<void>;
};

const A = "owner-a";
const B = "owner-b";

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as CoreError).code;
  }
  return "no error";
}

/** Delegates to any store and, after a duplicate insert, sets a why before the caller can. */
function racing(inner: LinkStore): LinkStore {
  return {
    async insertIfAbsent(owner, link) {
      const result = await inner.insertIfAbsent(owner, link);
      if (!result.created) {
        await inner.update(owner, result.link.id, {
          why: { text: "concurrent", source: "stated" },
        });
      }
      return result;
    },
    get: (owner, id) => inner.get(owner, id),
    update: (owner, id, patch) => inner.update(owner, id, patch),
    fillWhyIfMissing: (owner, id, why) => inner.fillWhyIfMissing(owner, id, why),
    listTags: (owner) => inner.listTags(owner),
  };
}

export function describeStoreContract(
  name: string,
  makeHarness: () => StoreHarness | Promise<StoreHarness>,
): void {
  describe(name, () => {
    let h: StoreHarness;
    let clock: Date;
    const deps = () => ({ store: h.store, now: () => clock });

    beforeEach(async () => {
      h = await makeHarness();
      await h.addOwner(A);
      await h.addOwner(B);
      clock = new Date("2026-01-01T00:00:00Z");
    });

    describe("saveLink", () => {
      it("dedupes two spellings of one URL and keeps the original", async () => {
        const first = await saveLink(deps(), A, {
          url: "https://Ex.com/a/?utm_source=x",
          savedBy: "agent",
          title: "T",
        });
        clock = new Date("2026-02-02T00:00:00Z");
        const second = await saveLink(deps(), A, { url: "HTTPS://ex.com:443/a", savedBy: "web" });
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.link.id).toBe(first.link.id);
        expect(second.link.savedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
        expect(second.link.savedBy).toBe("agent");
        expect(second.link.url).toBe("https://Ex.com/a/?utm_source=x");
        expect(await h.all(A)).toHaveLength(1);
      });

      it("fills a missing why on duplicate, with the new source, changing nothing else", async () => {
        await saveLink(deps(), A, {
          url: "https://ex.com/a",
          savedBy: "agent",
          title: "T",
          summary: "S",
          tags: [{ name: "x", source: "stated" }],
        });
        const { link } = await saveLink(deps(), A, {
          url: "https://ex.com/a/",
          savedBy: "agent",
          title: "other",
          summary: "other",
          tags: [{ name: "y", source: "stated" }],
          why: { text: " because ", source: "asked" },
        });
        expect(link.why).toEqual({ text: "because", source: "asked" });
        const [stored] = await h.all(A);
        expect(stored?.why).toEqual({ text: "because", source: "asked" });
        expect(stored?.title).toBe("T");
        expect(stored?.summary).toBe("S");
        expect(stored?.tags.map((t) => t.key)).toEqual(["x"]);
      });

      it("keeps an existing why on duplicate", async () => {
        const why: Labelled = { text: "first", source: "stated" };
        await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent", why });
        await saveLink(deps(), A, {
          url: "https://ex.com/a",
          savedBy: "agent",
          why: { text: "second", source: "inferred" },
        });
        expect((await h.all(A))[0]?.why).toEqual(why);
      });

      it("treats a blank why as missing", async () => {
        const { link } = await saveLink(deps(), A, {
          url: "https://ex.com/a",
          savedBy: "agent",
          why: { text: "   ", source: "stated" },
        });
        expect(link.why).toBeNull();
      });

      it("gives owner B a distinct link for owner A's URL", async () => {
        const a = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
        const b = await saveLink(deps(), B, { url: "https://ex.com/a", savedBy: "agent" });
        expect(b.created).toBe(true);
        expect(b.link.id).not.toBe(a.link.id);
      });

      it("rejects an invalid URL without touching the store", async () => {
        expect(await code(saveLink(deps(), A, { url: "ftp://x", savedBy: "agent" }))).toBe(
          "invalid_url",
        );
        expect(await h.all(A)).toHaveLength(0);
      });

      it("rejects a blank tag without touching the store", async () => {
        const p = saveLink(deps(), A, {
          url: "https://ex.com/a",
          savedBy: "agent",
          tags: [{ name: " ", source: "stated" }],
        });
        expect(await code(p)).toBe("invalid_input");
        expect(await h.all(A)).toHaveLength(0);
      });
    });

    describe("saveLink conditional why", () => {
      it("does not overwrite a why set concurrently between insert and fill", async () => {
        const raced = { store: racing(h.store), now: () => clock };
        await saveLink(raced, A, { url: "https://ex.com/a", savedBy: "agent" });
        await saveLink(raced, A, {
          url: "https://ex.com/a",
          savedBy: "agent",
          why: { text: "mine", source: "asked" },
        });
        expect((await h.all(A))[0]?.why).toEqual({ text: "concurrent", source: "stated" });
      });
    });

    describe("runtime input checks", () => {
      const bogus = "bogus" as never;

      it("saveLink rejects a bad why or tag source and stores nothing", async () => {
        const url = "https://ex.com/a";
        const badWhy = saveLink(deps(), A, {
          url,
          savedBy: "agent",
          why: { text: "w", source: bogus },
        });
        expect(await code(badWhy)).toBe("invalid_input");
        const badTag = saveLink(deps(), A, {
          url,
          savedBy: "agent",
          tags: [{ name: "t", source: bogus }],
        });
        expect(await code(badTag)).toBe("invalid_input");
        expect(await h.all(A)).toHaveLength(0);
      });

      it("updateLink rejects a bad state, why source or tag source and changes nothing", async () => {
        const { link } = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
        const before = structuredClone(await h.all(A));
        const patches = [
          { state: bogus },
          { why: { text: "w", source: bogus } },
          { tags: [{ name: "t", source: bogus }] },
        ];
        for (const patch of patches) {
          expect(await code(updateLink(deps(), A, link.id, patch))).toBe("invalid_input");
        }
        expect(await h.all(A)).toEqual(before);
      });

      it("updateLink ignores keys outside the allowed update fields", async () => {
        const { link } = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
        const forbidden = {
          id: "zzz",
          urlKey: "evil",
          savedBy: "web",
          url: "http://x",
          savedAt: clock,
        };
        const updated = await updateLink(deps(), A, link.id, {
          summary: "s",
          ...forbidden,
        } as never);
        expect(updated.summary).toBe("s");
        expect(await h.all(A)).toEqual([{ ...link, summary: "s" }]);
      });
    });

    describe("getLink", () => {
      it("throws not_found for an unknown id", async () => {
        expect(await code(getLink(deps(), A, "nope"))).toBe("not_found");
      });

      it("throws not_found for another owner's link", async () => {
        const { link } = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
        expect(await code(getLink(deps(), B, link.id))).toBe("not_found");
        expect((await getLink(deps(), A, link.id)).id).toBe(link.id);
      });
    });

    describe("tag catalog", () => {
      const url = "https://ex.com/a";
      const projectTag: Tag = {
        key: "sleep",
        name: "Sleep",
        kind: "project",
        color: "blue",
        pinned: true,
        description: "d",
        projectStatus: "active",
      };

      it("returns the first-seen name for every link, whatever casing it was saved with", async () => {
        const one = await saveLink(deps(), A, {
          url,
          savedBy: "agent",
          tags: [{ name: "Sleep", source: "stated" }],
        });
        const two = await saveLink(deps(), A, {
          url: "https://ex.com/b",
          savedBy: "agent",
          tags: [{ name: "sleep", source: "asked" }],
        });
        expect(one.link.tags[0]?.name).toBe("Sleep");
        expect(two.link.tags).toEqual([{ key: "sleep", name: "Sleep", source: "asked" }]);
        expect((await getLink(deps(), A, two.link.id)).tags[0]?.name).toBe("Sleep");
        expect((await h.all(A))[1]?.tags[0]?.name).toBe("Sleep");
        expect((await h.catalog(A)).map((t) => t.name)).toEqual(["Sleep"]);
      });

      it("a duplicate save creates no catalog entry and leaves the link's tags alone", async () => {
        await saveLink(deps(), A, {
          url,
          savedBy: "agent",
          tags: [{ name: "x", source: "stated" }],
        });
        const { link, created } = await saveLink(deps(), A, {
          url: `${url}/`,
          savedBy: "agent",
          tags: [{ name: "brand new", source: "stated" }],
        });
        expect(created).toBe(false);
        expect(link.tags.map((t) => t.key)).toEqual(["x"]);
        expect((await h.catalog(A)).map((t) => t.key)).toEqual(["x"]);
      });

      it("re-tagging via update keeps an existing tag's metadata and catalog name", async () => {
        await h.seedTag(A, projectTag);
        const { link } = await saveLink(deps(), A, { url, savedBy: "agent" });
        const updated = await updateLink(deps(), A, link.id, {
          tags: [
            { name: "SLEEP", source: "inferred" },
            { name: "fresh", source: "stated" },
          ],
        });
        expect(updated.tags).toEqual([
          { key: "sleep", name: "Sleep", source: "inferred" },
          { key: "fresh", name: "fresh", source: "stated" },
        ]);
        expect(await h.catalog(A)).toEqual([
          projectTag,
          {
            key: "fresh",
            name: "fresh",
            kind: "topic",
            color: null,
            pinned: false,
            description: null,
            projectStatus: null,
          },
        ]);
      });
    });

    describe("tag order and owners", () => {
      const tag = (name: string) => [{ name, source: "stated" as const }];
      const keys = (l: Link) => l.tags.map((t) => t.key);

      it("returns tags in the order attached, whatever order the catalog was created in", async () => {
        await saveLink(deps(), A, { url: "https://ex.com/1", savedBy: "agent", tags: tag("Beta") });
        await saveLink(deps(), A, {
          url: "https://ex.com/2",
          savedBy: "agent",
          tags: tag("Alpha"),
        });
        expect((await h.catalog(A)).map((t) => t.key)).toEqual(["beta", "alpha"]);
        const both = [...tag("Alpha"), ...tag("Beta")];
        const url = "https://ex.com/3";
        const saved = await saveLink(deps(), A, { url, savedBy: "agent", tags: both });
        expect(keys(saved.link)).toEqual(["alpha", "beta"]);
        const again = await saveLink(deps(), A, { url, savedBy: "agent", tags: both });
        expect(again.created).toBe(false);
        expect(keys(again.link)).toEqual(["alpha", "beta"]);
        expect(keys(await getLink(deps(), A, saved.link.id))).toEqual(["alpha", "beta"]);
        const reversed = await updateLink(deps(), A, saved.link.id, { tags: [...both].reverse() });
        expect(keys(reversed)).toEqual(["beta", "alpha"]);
        const reset = await updateLink(deps(), A, saved.link.id, { tags: both });
        expect(keys(reset)).toEqual(["alpha", "beta"]);
      });

      it("keeps each owner's catalog separate", async () => {
        const projectTag: Tag = {
          key: "sleep",
          name: "Sleep",
          kind: "project",
          color: "blue",
          pinned: true,
          description: "d",
          projectStatus: "active",
        };
        await h.seedTag(A, projectTag);
        const { link } = await saveLink(deps(), B, {
          url: "https://ex.com/a",
          savedBy: "agent",
          tags: tag("sleep"),
        });
        expect(link.tags).toEqual([{ key: "sleep", name: "sleep", source: "stated" }]);
        expect(await h.catalog(B)).toEqual([
          {
            key: "sleep",
            name: "sleep",
            kind: "topic",
            color: null,
            pinned: false,
            description: null,
            projectStatus: null,
          },
        ]);
        expect(await h.catalog(A)).toEqual([projectTag]);
      });
    });

    describe("listTags", () => {
      const topic = (key: string, name = key): Tag => ({
        key,
        name,
        kind: "topic",
        color: null,
        pinned: false,
        description: null,
        projectStatus: null,
      });
      const attach = (owner: string, n: number, ...names: string[]) =>
        saveLink(deps(), owner, {
          url: `https://ex.com/${n}`,
          savedBy: "agent",
          tags: names.map((name) => ({ name, source: "stated" as const })),
        });

      it("lists tags created by attaching, with the first-saved name and topic defaults", async () => {
        await attach(A, 1, "Sleep");
        await attach(A, 2, "sleep", "Naps");
        expect(await h.store.listTags(A)).toEqual([topic("naps", "Naps"), topic("sleep", "Sleep")]);
      });

      it("returns seeded tags with every field intact", async () => {
        const seeded: Tag = {
          key: "sleep",
          name: "Sleep",
          kind: "project",
          color: "blue",
          pinned: true,
          description: "d",
          projectStatus: "done",
        };
        await h.seedTag(A, seeded);
        expect(await h.store.listTags(A)).toEqual([seeded]);
      });

      it("orders by key, not by creation", async () => {
        await attach(A, 1, "Zeta", "Mid");
        await attach(A, 2, "Alpha");
        expect((await h.catalog(A)).map((t) => t.key)).toEqual(["zeta", "mid", "alpha"]);
        expect((await h.store.listTags(A)).map((t) => t.key)).toEqual(["alpha", "mid", "zeta"]);
      });

      it("orders non-ASCII keys by code point", async () => {
        await attach(A, 1, "😀", "ｆ");
        expect((await h.store.listTags(A)).map((t) => t.key)).toEqual(["ｆ", "😀"]);
      });

      it("never shows another owner's tags and is unchanged by their writes", async () => {
        await attach(A, 1, "Shared");
        const before = await h.store.listTags(A);
        await attach(B, 2, "shared", "Only B");
        await h.seedTag(B, { ...topic("zzz"), kind: "project", projectStatus: "active" });
        expect(await h.store.listTags(A)).toEqual(before);
        expect(before).toEqual([topic("shared", "Shared")]);
        expect((await h.store.listTags(B)).map((t) => t.key)).toEqual(["only b", "shared", "zzz"]);
      });

      it("gives an owner with no tags an empty list", async () => {
        await attach(B, 1, "x");
        expect(await h.store.listTags(A)).toEqual([]);
        expect(await h.store.listTags("no-such-owner")).toEqual([]);
      });
    });

    describe("LinkStore directly", () => {
      const patch = {
        summary: "changed",
        state: "archived" as const,
        tags: [{ key: "newtag", name: "NewTag", source: "stated" as const }],
      };
      const why: Labelled = { text: "filled", source: "stated" };
      const calls = {
        get: (s: LinkStore, id: string) => s.get(A, id),
        update: (s: LinkStore, id: string) => s.update(A, id, patch),
        fillWhyIfMissing: (s: LinkStore, id: string) => s.fillWhyIfMissing(A, id, why),
      };
      const snapshot = async () => [
        await h.all(A),
        await h.catalog(A),
        await h.all(B),
        await h.catalog(B),
      ];

      for (const [method, call] of Object.entries(calls)) {
        it(`${method} returns null and changes nothing for foreign, absent, malformed and out-of-range ids`, async () => {
          const tags = [{ name: "mine", source: "stated" as const }];
          const mine = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "a", tags });
          const theirs = await saveLink(deps(), B, { url: "https://ex.com/b", savedBy: "b", tags });
          const absent = theirs.link.id.replace(/\d+$/, (n) => String(Number(n) + 1000));
          expect(absent).not.toBe(theirs.link.id);
          const ids = [
            theirs.link.id,
            absent,
            "zzz",
            "01",
            "-1",
            "",
            "9007199254740993",
            "9223372036854775808",
          ];
          expect(ids).not.toContain(mine.link.id);
          const before = structuredClone(await snapshot());
          for (const id of ids) {
            expect(await call(h.store, id), `id "${id}"`).toBeNull();
          }
          expect(await snapshot()).toEqual(before);
        });
      }
    });

    describe("updateLink", () => {
      it("replaces the tag set, normalized", async () => {
        const { link } = await saveLink(deps(), A, {
          url: "https://ex.com/a",
          savedBy: "agent",
          tags: [{ name: "old", source: "stated" }],
        });
        const updated = await updateLink(deps(), A, link.id, {
          tags: [{ name: " New  Tag ", source: "inferred" }],
        });
        expect(updated.tags).toEqual([{ key: "new tag", name: "New Tag", source: "inferred" }]);
        expect((await h.all(A))[0]?.tags).toEqual(updated.tags);
      });

      it("leaves why and tags alone when only summary changes", async () => {
        const why: Labelled = { text: "w", source: "stated" };
        const { link } = await saveLink(deps(), A, {
          url: "https://ex.com/a",
          savedBy: "agent",
          why,
          tags: [{ name: "t", source: "stated" }],
        });
        const updated = await updateLink(deps(), A, link.id, { summary: "new" });
        expect(updated.summary).toBe("new");
        expect(updated.why).toEqual(why);
        expect(updated.tags.map((t) => t.key)).toEqual(["t"]);
      });

      it("trims a new why and treats a blank one as missing", async () => {
        const { link } = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
        const set = await updateLink(deps(), A, link.id, {
          why: { text: "  w  ", source: "asked" },
        });
        expect(set.why).toEqual({ text: "w", source: "asked" });
        const cleared = await updateLink(deps(), A, link.id, {
          why: { text: " ", source: "stated" },
        });
        expect(cleared.why).toBeNull();
        expect((await h.all(A))[0]?.why).toBeNull();
      });

      it("applies state, snoozedUntil and lastOpenedAt", async () => {
        const { link } = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
        const snooze = new Date("2026-03-01T00:00:00Z");
        const updated = await updateLink(deps(), A, link.id, {
          state: "archived",
          snoozedUntil: snooze,
        });
        expect(updated).toMatchObject({
          state: "archived",
          snoozedUntil: snooze,
          lastOpenedAt: null,
        });
      });

      it("rejects an invalid snoozedUntil and keeps the existing snooze", async () => {
        const { link } = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
        const snooze = new Date("2026-03-01T00:00:00Z");
        await updateLink(deps(), A, link.id, { snoozedUntil: snooze });
        for (const bad of [new Date("nope"), "2026-04-01", 1_700_000_000_000]) {
          const p = updateLink(deps(), A, link.id, { snoozedUntil: bad as never });
          expect(await code(p)).toBe("invalid_input");
        }
        expect((await h.all(A))[0]?.snoozedUntil).toEqual(snooze);
        const cleared = await updateLink(deps(), A, link.id, { snoozedUntil: null });
        expect(cleared.snoozedUntil).toBeNull();
      });

      it("stamps lastOpenedAt from the injected clock when opened is set", async () => {
        const { link } = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
        clock = new Date("2026-05-05T12:00:00Z");
        const updated = await updateLink(deps(), A, link.id, { opened: true });
        expect(updated.lastOpenedAt).toEqual(new Date("2026-05-05T12:00:00Z"));
        expect((await h.all(A))[0]?.lastOpenedAt).toEqual(new Date("2026-05-05T12:00:00Z"));
      });

      it("does not accept a caller-supplied lastOpenedAt", async () => {
        const { link } = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
        const forged = { lastOpenedAt: new Date("1999-01-01T00:00:00Z") } as never;
        const updated = await updateLink(deps(), A, link.id, forged);
        expect(updated.lastOpenedAt).toBeNull();
      });

      it("throws not_found for another owner and leaves the link unchanged", async () => {
        const { link } = await saveLink(deps(), A, {
          url: "https://ex.com/a",
          savedBy: "agent",
          summary: "orig",
        });
        const before = structuredClone(await h.all(A));
        const p = updateLink(deps(), B, link.id, { summary: "hacked", state: "archived" });
        expect(await code(p)).toBe("not_found");
        expect(await h.all(A)).toEqual(before);
      });
    });
  });
}
