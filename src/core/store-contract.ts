import { beforeEach, describe, expect, it } from "vitest";
import type { CoreError } from "./errors.js";
import { filingContext } from "./filing-context.js";
import { getLink, saveLink, updateLink, updateLinkWithReceipt } from "./links.js";
import { setProjectStatus } from "./project-status.js";
import { type SavePageInput, savePage } from "./save-page.js";
import type { LinkRemover, LinkStore } from "./store.js";
import { changeTagKind } from "./tag-kind.js";
import { SPACE_COLORS, setTagColor, setTagPinned } from "./tag-space.js";
import type { Labelled, Link, LinkEventKind, SummarySource, Tag, TagKind } from "./types.js";

type MaybeAsync<T> = T | Promise<T>;

/** What the contract suite needs from a store under test. */
export type StoreHarness = {
  store: LinkStore & LinkRemover;
  /** Make the owner exist, for stores that require it. */
  addOwner(owner: string): MaybeAsync<void>;
  /** Every link the owner has, bypassing the LinkStore interface. */
  all(owner: string): MaybeAsync<Link[]>;
  /** The owner's tag catalog, in creation order. */
  catalog(owner: string): MaybeAsync<Tag[]>;
  seedTag(owner: string, tag: Tag): MaybeAsync<void>;
  /** The owner's log events for one link, in the order they were written, bypassing the LinkStore interface. */
  eventsOf(owner: string, id: string): MaybeAsync<LoggedEvent[]>;
};

/** One row of a link's event log, as the harness reads it back. */
export type LoggedEvent = { kind: LinkEventKind; at: Date; backfilled: boolean };

const A = "owner-a";
const B = "owner-b";
const EPOCH = new Date(0);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as CoreError).code;
  }
  return "no error";
}

/** Delegates every method to the store, except those overridden. */
function wrap(inner: LinkStore, over: Partial<LinkStore> = {}): LinkStore {
  return {
    insertIfAbsent: (owner, link) => inner.insertIfAbsent(owner, link),
    get: (owner, id) => inner.get(owner, id),
    update: (owner, id, patch, events) => inner.update(owner, id, patch, events),
    updateWithReceipt: (owner, id, patch, at, extend, events) =>
      inner.updateWithReceipt(owner, id, patch, at, extend, events),
    fillWhyIfMissing: (owner, id, why) => inner.fillWhyIfMissing(owner, id, why),
    fillWhyWithReceipt: (owner, id, why, at, extend) =>
      inner.fillWhyWithReceipt(owner, id, why, at, extend),
    listTags: (owner) => inner.listTags(owner),
    updateTag: (owner, key, patch, expected) => inner.updateTag(owner, key, patch, expected),
    pinTag: (owner, key, pin) => inner.pinTag(owner, key, pin),
    colorTag: (owner, key, color) => inner.colorTag(owner, key, color),
    listLinks: (owner) => inner.listLinks(owner),
    claimSurfaced: (owner, ids, when) => inner.claimSurfaced(owner, ids, when),
    unclaimSurfaced: (owner, id, claim) => inner.unclaimSurfaced(owner, id, claim),
    updateIf: (owner, id, expected, patch, events) =>
      inner.updateIf(owner, id, expected, patch, events),
    ...over,
  };
}

/** Delegates to any store and, after a duplicate insert, sets a why before the caller can. */
function racing(inner: LinkStore): LinkStore {
  return wrap(inner, {
    async insertIfAbsent(owner, link) {
      const result = await inner.insertIfAbsent(owner, link);
      if (!result.created) {
        await inner.update(owner, result.link.id, {
          why: { text: "concurrent", source: "stated" },
        });
      }
      return result;
    },
  });
}

/**
 * Before each of the first `flips` tag writes, another caller flips the tag to the other kind
 * (done when it becomes a project).
 */
function racingTagWrite(inner: LinkStore, flips = Number.POSITIVE_INFINITY): LinkStore {
  let flipped = 0;
  return wrap(inner, {
    async updateTag(owner, key, patch, expected) {
      if (flipped++ < flips) {
        const other: TagKind = expected === "topic" ? "project" : "topic";
        await inner.updateTag(
          owner,
          key,
          { kind: other, projectStatus: other === "project" ? "done" : null },
          expected,
        );
      }
      return inner.updateTag(owner, key, patch, expected);
    },
  });
}

/** Before each tag write, another caller marks the project done: a status change the writer never read. */
function racingStatusWrite(inner: LinkStore): LinkStore {
  return wrap(inner, {
    async updateTag(owner, key, patch, expected) {
      await inner.updateTag(owner, key, { projectStatus: "done" }, expected);
      return inner.updateTag(owner, key, patch, expected);
    },
  });
}

/** Counts the tag writes that reach the store. */
function countingTagWrites(inner: LinkStore): { store: LinkStore; calls: () => number } {
  let n = 0;
  const store = wrap(inner, {
    updateTag(owner, key, patch, expected) {
      n++;
      return inner.updateTag(owner, key, patch, expected);
    },
  });
  return { store, calls: () => n };
}

/** Counts the color writes that reach the store. */
function countingColorWrites(inner: LinkStore): { store: LinkStore; calls: () => number } {
  let n = 0;
  const store = wrap(inner, {
    colorTag(owner, key, color) {
      n++;
      return inner.colorTag(owner, key, color);
    },
  });
  return { store, calls: () => n };
}

const tagOf = (key: string, over: Partial<Tag> = {}): Tag => ({
  key,
  name: key,
  kind: "topic",
  kindSource: "inferred",
  color: null,
  pinned: false,
  description: null,
  projectStatus: null,
  ...over,
});

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
        const badKind = saveLink(deps(), A, {
          url,
          savedBy: "agent",
          tags: [{ name: "t", source: "stated", kind: bogus }],
        });
        expect(await code(badKind)).toBe("invalid_input");
        expect(await h.all(A)).toHaveLength(0);
        expect(await h.catalog(A)).toEqual([]);
      });

      it("updateLink rejects a bad state, why source or tag source and changes nothing", async () => {
        const { link } = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
        const before = structuredClone(await h.all(A));
        const patches = [
          { state: bogus },
          { why: { text: "w", source: bogus } },
          { tags: [{ name: "t", source: bogus }] },
          { tags: [{ name: "t", source: "stated" as const, kind: bogus }] },
        ];
        for (const patch of patches) {
          expect(await code(updateLink(deps(), A, link.id, patch))).toBe("invalid_input");
        }
        expect(await h.all(A)).toEqual(before);
        expect(await h.catalog(A)).toEqual([]);
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
        expect(await h.all(A)).toEqual([{ ...link, summary: "s", summarySource: "inferred" }]);
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
        kindSource: "stated",
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
        expect(two.link.tags).toEqual([
          { key: "sleep", name: "Sleep", source: "asked", kind: "topic", kindSource: "inferred" },
        ]);
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

      it("creates a new tag with the requested kind, and topic by default", async () => {
        const { link } = await saveLink(deps(), A, {
          url,
          savedBy: "agent",
          tags: [
            { name: "Home Batteries", source: "stated", kind: "project" },
            { name: "solar", source: "stated", kind: "topic" },
            { name: "wind", source: "stated" },
          ],
        });
        const kinds = (tags: { key: string; kind: string }[]) => tags.map((t) => [t.key, t.kind]);
        const expected = [
          ["home batteries", "project"],
          ["solar", "topic"],
          ["wind", "topic"],
        ];
        expect(kinds(link.tags)).toEqual(expected);
        expect(kinds(await h.store.listTags(A))).toEqual([...expected].sort());
      });

      it("update creates new tags with their requested kind too", async () => {
        const { link } = await saveLink(deps(), A, { url, savedBy: "agent" });
        const updated = await updateLink(deps(), A, link.id, {
          tags: [{ name: "Kitchen", source: "asked", kind: "project" }],
        });
        expect(updated.tags.map((t) => t.kind)).toEqual(["project"]);
        expect((await h.store.listTags(A)).map((t) => t.kind)).toEqual(["project"]);
      });

      it("attaching an existing tag with another kind changes neither catalog nor LinkTag", async () => {
        await saveLink(deps(), A, {
          url,
          savedBy: "agent",
          tags: [{ name: "Sleep", source: "stated" }],
        });
        const second = await saveLink(deps(), A, {
          url: "https://ex.com/b",
          savedBy: "agent",
          tags: [{ name: "sleep", source: "stated", kind: "project" }],
        });
        expect(second.link.tags.map((t) => t.kind)).toEqual(["topic"]);
        expect((await h.store.listTags(A)).map((t) => t.kind)).toEqual(["topic"]);
        const { link } = await saveLink(deps(), A, { url: "https://ex.com/c", savedBy: "agent" });
        const updated = await updateLink(deps(), A, link.id, {
          tags: [{ name: "SLEEP", source: "stated", kind: "project" }],
        });
        expect(updated.tags.map((t) => t.kind)).toEqual(["topic"]);
        expect((await h.store.listTags(A)).map((t) => t.kind)).toEqual(["topic"]);
      });

      const kindSources = (tags: { key: string; kindSource: string }[]) =>
        tags.map((t) => [t.key, t.kindSource]);

      it("records who decided a new tag's kind: the winning mention's source when it gave a kind", async () => {
        const { link } = await saveLink(deps(), A, {
          url,
          savedBy: "agent",
          tags: [
            { name: "Guess", source: "inferred", kind: "project" },
            { name: "Told", source: "stated", kind: "project" },
            { name: "Asked", source: "asked", kind: "project" },
            { name: "Plain", source: "stated" },
            { name: "Mixed", source: "asked", kind: "project" },
            { name: "mixed", source: "stated" },
          ],
        });
        const expected = [
          ["guess", "inferred"],
          ["told", "stated"],
          ["asked", "asked"],
          ["plain", "inferred"],
          ["mixed", "inferred"],
        ];
        expect(kindSources(link.tags)).toEqual(expected);
        expect(kindSources(await h.store.listTags(A))).toEqual([...expected].sort());
        expect(kindSources((await h.all(A))[0]?.tags ?? [])).toEqual(expected);
      });

      it("update_link records the kind source of the tags it creates too", async () => {
        const { link } = await saveLink(deps(), A, { url, savedBy: "agent" });
        const updated = await updateLink(deps(), A, link.id, {
          tags: [
            { name: "Kitchen", source: "stated", kind: "project" },
            { name: "Pantry", source: "stated" },
          ],
        });
        expect(kindSources(updated.tags)).toEqual([
          ["kitchen", "stated"],
          ["pantry", "inferred"],
        ]);
        expect(kindSources(await h.store.listTags(A))).toEqual([
          ["kitchen", "stated"],
          ["pantry", "inferred"],
        ]);
      });

      it("a later mention never changes an existing tag's kind source", async () => {
        await saveLink(deps(), A, {
          url,
          savedBy: "agent",
          tags: [{ name: "Solar", source: "inferred", kind: "project" }],
        });
        const mentions = [
          { name: "solar", source: "stated" as const, kind: "project" as const },
          { name: "solar", source: "stated" as const },
          { name: "solar", source: "asked" as const, kind: "project" as const },
        ];
        for (const [i, mention] of mentions.entries()) {
          const saved = await saveLink(deps(), A, {
            url: `https://ex.com/new-${i}`,
            savedBy: "agent",
            tags: [mention],
          });
          expect(kindSources(saved.link.tags), `save ${i}`).toEqual([["solar", "inferred"]]);
          const { link } = await saveLink(deps(), A, {
            url: `https://ex.com/bare-${i}`,
            savedBy: "agent",
          });
          const updated = await updateLink(deps(), A, link.id, { tags: [mention] });
          expect(kindSources(updated.tags), `update ${i}`).toEqual([["solar", "inferred"]]);
        }
        expect(kindSources(await h.store.listTags(A))).toEqual([["solar", "inferred"]]);
        expect(await h.catalog(A)).toEqual([
          tagOf("solar", { name: "Solar", kind: "project", kindSource: "inferred" }),
        ]);
      });

      it("a confirmation shows on every link already carrying the tag, in every read", async () => {
        const first = await saveLink(deps(), A, {
          url,
          savedBy: "agent",
          tags: [{ name: "Solar", source: "inferred", kind: "project" }],
        });
        const asProject = { name: "solar", kind: "project" as const };
        await changeTagKind(deps(), A, asProject);
        const seen = (tags: { kindSource: string }[]) => tags.map((t) => t.kindSource);
        expect(seen((await getLink(deps(), A, first.link.id)).tags)).toEqual(["stated"]);
        expect(seen((await h.all(A))[0]?.tags ?? [])).toEqual(["stated"]);
        const again = await saveLink(deps(), A, { url, savedBy: "agent" });
        expect(again.created).toBe(false);
        expect(seen(again.link.tags)).toEqual(["stated"]);
        const context = await filingContext(deps(), A);
        expect(seen(context.tags)).toEqual(["stated"]);
        expect(seen(context.activeProjects)).toEqual(["stated"]);
      });

      it("another owner's tag keeps its kind source when this owner confirms theirs", async () => {
        await h.seedTag(A, tagOf("solar", { kind: "project" }));
        await h.seedTag(B, tagOf("solar", { kind: "project" }));
        await changeTagKind(deps(), A, { name: "solar", kind: "project" });
        expect(kindSources(await h.catalog(A))).toEqual([["solar", "stated"]]);
        expect(kindSources(await h.catalog(B))).toEqual([["solar", "inferred"]]);
      });

      it("returns no field beyond the schema's, however the tag was made or confirmed", async () => {
        const { link } = await saveLink(deps(), A, {
          url,
          savedBy: "agent",
          tags: [{ name: "Solar", source: "stated", kind: "project" }],
        });
        await changeTagKind(deps(), A, { name: "solar", kind: "topic" });
        const updated = await updateLink(deps(), A, link.id, {
          tags: [{ name: "solar", source: "asked", kind: "project" }],
        });
        const linkTagKeys = ["key", "kind", "kindSource", "name", "source"];
        const tagKeys = [
          "color",
          "description",
          "key",
          "kind",
          "kindSource",
          "name",
          "pinned",
          "projectStatus",
        ];
        const fromStores = [
          ...link.tags,
          ...updated.tags,
          ...((await h.all(A))[0]?.tags ?? []),
          ...((await h.store.get(A, link.id))?.tags ?? []),
        ];
        for (const t of fromStores) expect(Object.keys(t).sort()).toEqual(linkTagKeys);
        const catalogTags = [...(await h.store.listTags(A)), ...(await h.catalog(A))];
        for (const t of catalogTags) expect(Object.keys(t).sort()).toEqual(tagKeys);
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
          {
            key: "sleep",
            name: "Sleep",
            source: "inferred",
            kind: "project",
            kindSource: "stated",
          },
          { key: "fresh", name: "fresh", source: "stated", kind: "topic", kindSource: "inferred" },
        ]);
        expect(await h.catalog(A)).toEqual([
          projectTag,
          {
            key: "fresh",
            name: "fresh",
            kind: "topic",
            kindSource: "inferred",
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
          kindSource: "stated",
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
        expect(link.tags).toEqual([
          { key: "sleep", name: "sleep", source: "stated", kind: "topic", kindSource: "inferred" },
        ]);
        expect(await h.catalog(B)).toEqual([
          {
            key: "sleep",
            name: "sleep",
            kind: "topic",
            kindSource: "inferred",
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
        kindSource: "inferred",
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
          kindSource: "asked",
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

    describe("updateTag", () => {
      const solarA = tagOf("solar", {
        name: "Solar",
        color: "blue",
        pinned: true,
        description: "d",
      });
      const solarB = tagOf("solar", { name: "Solar B", color: "red" });

      it("changes only the owner's tag with a matching kind, and links read it at once", async () => {
        await h.seedTag(A, solarA);
        await h.seedTag(B, solarB);
        const { link } = await saveLink(deps(), A, {
          url: "https://ex.com/1",
          savedBy: "agent",
          tags: [{ name: "solar", source: "inferred" }],
        });
        const updated = await h.store.updateTag(A, "solar", { kind: "project" }, "topic");
        expect(updated).toEqual({ ...solarA, kind: "project" });
        const read = await h.store.get(A, link.id);
        expect(read?.tags).toEqual([
          {
            key: "solar",
            name: "Solar",
            source: "inferred",
            kind: "project",
            kindSource: "inferred",
          },
        ]);
        expect(await h.catalog(A)).toEqual([{ ...solarA, kind: "project" }]);
        expect(await h.catalog(B)).toEqual([solarB]);
      });

      it("writes nothing and returns null for an absent key, another owner's key, or a moved kind", async () => {
        await h.seedTag(A, solarA);
        await h.seedTag(B, tagOf("only-b"));
        const beforeA = await h.catalog(A);
        const beforeB = await h.catalog(B);
        expect(await h.store.updateTag(A, "absent", { kind: "project" }, "topic")).toBeNull();
        expect(await h.store.updateTag(A, "only-b", { kind: "project" }, "topic")).toBeNull();
        expect(
          await h.store.updateTag(A, "solar", { kind: "topic", projectStatus: null }, "project"),
        ).toBeNull();
        expect(await h.catalog(A)).toEqual(beforeA);
        expect(await h.catalog(B)).toEqual(beforeB);
      });

      it("applies only the fields in the patch", async () => {
        await h.seedTag(A, tagOf("solar", { kind: "project", projectStatus: "active" }));
        const done = await h.store.updateTag(A, "solar", { projectStatus: "done" }, "project");
        expect(done).toMatchObject({ kind: "project", projectStatus: "done" });
        const same = await h.store.updateTag(A, "solar", {}, "project");
        expect(same).toMatchObject({ kind: "project", projectStatus: "done" });
        expect(await h.catalog(A)).toEqual([
          tagOf("solar", { kind: "project", projectStatus: "done" }),
        ]);
      });

      it("sets the kind source alone, leaving kind and project status, only while the kind matches", async () => {
        await h.seedTag(A, tagOf("solar", { kind: "project", projectStatus: "done" }));
        expect(await h.store.updateTag(A, "solar", { kindSource: "stated" }, "topic")).toBeNull();
        expect((await h.catalog(A))[0]?.kindSource).toBe("inferred");
        const tag = await h.store.updateTag(A, "solar", { kindSource: "stated" }, "project");
        expect(tag).toEqual(
          tagOf("solar", { kind: "project", kindSource: "stated", projectStatus: "done" }),
        );
        expect(await h.catalog(A)).toEqual([tag]);
      });
    });

    describe("pinTag and colorTag", () => {
      const solar = tagOf("solar", {
        name: "Solar",
        kind: "project",
        kindSource: "asked",
        description: "d",
        projectStatus: "done",
      });

      it("pinning gives a tag with no color the one passed, and changes nothing else", async () => {
        await h.seedTag(A, solar);
        await h.seedTag(B, tagOf("solar"));
        const pinned = await h.store.pinTag(A, "solar", { pinned: true, color: "teal" });
        expect(pinned).toEqual({ ...solar, pinned: true, color: "teal" });
        expect(await h.catalog(A)).toEqual([pinned]);
        expect(await h.catalog(B)).toEqual([tagOf("solar")]);
      });

      it("pinning keeps a color the tag already has, so a pinned tag always has one", async () => {
        await h.seedTag(A, { ...solar, color: "violet" });
        const pinned = await h.store.pinTag(A, "solar", { pinned: true, color: "teal" });
        expect(pinned).toEqual({ ...solar, pinned: true, color: "violet" });
        expect(await h.catalog(A)).toEqual([pinned]);
      });

      it("unpinning keeps the color, and pinning again brings it back", async () => {
        await h.seedTag(A, { ...solar, pinned: true, color: "clay" });
        const unpinned = await h.store.pinTag(A, "solar", { pinned: false });
        expect(unpinned).toEqual({ ...solar, pinned: false, color: "clay" });
        expect(await h.catalog(A)).toEqual([unpinned]);
        const again = await h.store.pinTag(A, "solar", { pinned: true, color: "teal" });
        expect(again).toEqual({ ...solar, pinned: true, color: "clay" });
      });

      it("colorTag sets only the color, whatever the kind and pin", async () => {
        await h.seedTag(A, { ...solar, pinned: true, color: "clay" });
        await h.seedTag(B, tagOf("solar", { color: "rose" }));
        const colored = await h.store.colorTag(A, "solar", "green");
        expect(colored).toEqual({ ...solar, pinned: true, color: "green" });
        expect(await h.catalog(A)).toEqual([colored]);
        expect(await h.catalog(B)).toEqual([tagOf("solar", { color: "rose" })]);
      });

      it("both write nothing and return null for an absent key or another owner's key", async () => {
        await h.seedTag(A, solar);
        await h.seedTag(B, tagOf("only-b"));
        const beforeA = await h.catalog(A);
        const beforeB = await h.catalog(B);
        expect(await h.store.pinTag(A, "absent", { pinned: true, color: "teal" })).toBeNull();
        expect(await h.store.pinTag(A, "only-b", { pinned: true, color: "teal" })).toBeNull();
        expect(await h.store.pinTag(A, "only-b", { pinned: false })).toBeNull();
        expect(await h.store.colorTag(A, "only-b", "teal")).toBeNull();
        expect(await h.store.colorTag(A, "absent", "teal")).toBeNull();
        expect(await h.catalog(A)).toEqual(beforeA);
        expect(await h.catalog(B)).toEqual(beforeB);
      });
    });

    describe("setTagColor", () => {
      it.each(SPACE_COLORS.map((c) => [c]))("sets %s, matching the name loosely", async (color) => {
        await h.seedTag(A, tagOf("home batteries", { name: "Home Batteries" }));
        await h.seedTag(B, tagOf("home batteries"));
        const tag = await setTagColor(deps(), A, { name: " HOME  batteries", color });
        expect(tag).toEqual(tagOf("home batteries", { name: "Home Batteries", color }));
        expect(await h.catalog(A)).toEqual([tag]);
        expect(await h.catalog(B)).toEqual([tagOf("home batteries")]);
      });

      it.each([["amber"], ["Teal"], ["red"], ["#2F8F83"], [""], [7], [null]])(
        "refuses %j without writing",
        async (color) => {
          await h.seedTag(A, tagOf("solar", { color: "clay" }));
          const counted = countingColorWrites(h.store);
          const refused = setTagColor({ store: counted.store }, A, {
            name: "solar",
            color: color as never,
          });
          expect(await code(refused)).toBe("invalid_input");
          expect(counted.calls()).toBe(0);
          expect(await h.catalog(A)).toEqual([tagOf("solar", { color: "clay" })]);
        },
      );

      it("refuses an unknown tag and a blank name", async () => {
        await h.seedTag(B, tagOf("only-b"));
        expect(await code(setTagColor(deps(), A, { name: "only-b", color: "teal" }))).toBe(
          "not_found",
        );
        expect(await code(setTagColor(deps(), A, { name: " ", color: "teal" }))).toBe(
          "invalid_input",
        );
        expect(await h.catalog(B)).toEqual([tagOf("only-b")]);
      });
    });

    describe("setTagPinned", () => {
      const pin = (name: string, store: LinkStore = h.store) =>
        setTagPinned({ store }, A, { name, pinned: true });
      const unpin = (name: string) => setTagPinned(deps(), A, { name, pinned: false });

      it("gives a new pin the first color no tag holds, counting unpinned tags", async () => {
        await h.seedTag(A, tagOf("a", { color: "teal" }));
        await h.seedTag(A, tagOf("b", { color: "clay", pinned: true }));
        await h.seedTag(A, tagOf("c"));
        expect(await pin("c")).toEqual(tagOf("c", { color: "violet", pinned: true }));
      });

      it("gives two pins different colors while a color is free, though the first was unpinned", async () => {
        await h.seedTag(A, tagOf("kitchen"));
        await h.seedTag(A, tagOf("baking"));
        expect((await pin("kitchen"))?.color).toBe("teal");
        expect(await unpin("kitchen")).toEqual(tagOf("kitchen", { color: "teal" }));
        expect((await pin("baking"))?.color).toBe("clay");
      });

      it("once every color is held, gives the first color no pinned tag holds", async () => {
        for (const color of SPACE_COLORS) {
          await h.seedTag(A, tagOf(color, { color, pinned: color !== "blue" }));
        }
        await h.seedTag(A, tagOf("new"));
        expect((await pin("new"))?.color).toBe("blue");
      });

      it("gives teal once every color is held by a pinned tag", async () => {
        for (const [i, color] of ["rose", ...SPACE_COLORS].entries()) {
          await h.seedTag(A, tagOf(`x${i}`, { color, pinned: true }));
        }
        await h.seedTag(A, tagOf("new"));
        expect((await pin("new"))?.color).toBe("teal");
      });

      it("keeps a tag's own color on pin and unpin, so pinning again brings the same color", async () => {
        await h.seedTag(A, tagOf("solar", { color: "green", kind: "project" }));
        expect(await pin("solar")).toEqual(
          tagOf("solar", { color: "green", kind: "project", pinned: true }),
        );
        expect(await unpin("solar")).toEqual(tagOf("solar", { color: "green", kind: "project" }));
        expect(await pin("solar")).toEqual(
          tagOf("solar", { color: "green", kind: "project", pinned: true }),
        );
      });

      it("keeps a color the owner chose between the read and the pin", async () => {
        await h.seedTag(A, tagOf("solar"));
        const racing = wrap(h.store, {
          async pinTag(owner, key, p) {
            await h.store.colorTag(owner, key, "violet");
            return h.store.pinTag(owner, key, p);
          },
        });
        expect(await pin("solar", racing)).toEqual(
          tagOf("solar", { color: "violet", pinned: true }),
        );
        expect(await h.catalog(A)).toEqual([tagOf("solar", { color: "violet", pinned: true })]);
      });

      it("refuses an unknown tag, another owner's, and a blank name, writing nothing", async () => {
        await h.seedTag(B, tagOf("only-b"));
        expect(await code(pin("absent"))).toBe("not_found");
        expect(await code(pin("only-b"))).toBe("not_found");
        expect(await code(unpin("  "))).toBe("invalid_input");
        expect(await h.catalog(B)).toEqual([tagOf("only-b")]);
      });
    });

    describe("setProjectStatus", () => {
      const project = tagOf("solar", { kind: "project", kindSource: "stated" });
      const status = (s: "active" | "done", store: LinkStore = h.store) =>
        setProjectStatus({ store }, A, { name: "Solar", status: s });

      it("marks a project done, which takes it out of active projects, and reopens it", async () => {
        await h.seedTag(A, { ...project, projectStatus: "active" });
        await h.seedTag(B, { ...project, projectStatus: "active" });
        expect(await status("done")).toEqual({ ...project, projectStatus: "done" });
        expect((await filingContext(deps(), A)).activeProjects).toEqual([]);
        expect(await status("active")).toEqual({ ...project, projectStatus: "active" });
        expect((await filingContext(deps(), A)).activeProjects.map((t) => t.key)).toEqual([
          "solar",
        ]);
        expect(await h.catalog(B)).toEqual([{ ...project, projectStatus: "active" }]);
      });

      it("refuses a topic, and its row is unchanged", async () => {
        await h.seedTag(A, tagOf("solar", { color: "teal" }));
        const counted = countingTagWrites(h.store);
        expect(await code(status("done", counted.store))).toBe("invalid_input");
        expect(counted.calls()).toBe(0);
        expect(await h.catalog(A)).toEqual([tagOf("solar", { color: "teal" })]);
      });

      it("refuses a status that is not active or done, writing nothing", async () => {
        await h.seedTag(A, project);
        for (const bad of ["archived", null, ""]) {
          const refused = setProjectStatus(deps(), A, { name: "solar", status: bad as never });
          expect(await code(refused)).toBe("invalid_input");
        }
        expect(await h.catalog(A)).toEqual([project]);
      });

      it("refuses a project that became a topic while it ran, writing no status", async () => {
        await h.seedTag(A, { ...project, projectStatus: "active" });
        expect(await code(status("done", racingTagWrite(h.store, 1)))).toBe("invalid_input");
        expect(await h.catalog(A)).toEqual([
          tagOf("solar", { kindSource: "stated", projectStatus: null }),
        ]);
      });

      it("is a conflict when the kind keeps moving, after one retry", async () => {
        await h.seedTag(A, project);
        let writes = 0;
        const moving = wrap(h.store, {
          async updateTag() {
            writes++;
            return null;
          },
        });
        expect(await code(status("done", moving))).toBe("conflict");
        expect(writes).toBe(2);
        expect(await h.catalog(A)).toEqual([project]);
      });

      it("refuses an unknown tag and another owner's", async () => {
        await h.seedTag(B, project);
        expect(await code(status("done"))).toBe("not_found");
        expect(await h.catalog(B)).toEqual([project]);
      });
    });

    describe("changeTagKind", () => {
      const asProject = { name: "solar", kind: "project" as const };

      it("matches the name ignoring case and spaces, and keeps the first casing", async () => {
        await h.seedTag(A, tagOf("home batteries", { name: "Home Batteries" }));
        const tag = await changeTagKind(deps(), A, {
          name: "  HOME   batteries ",
          kind: "project",
        });
        expect(tag).toEqual(
          tagOf("home batteries", {
            name: "Home Batteries",
            kind: "project",
            kindSource: "stated",
          }),
        );
        expect(await h.catalog(A)).toEqual([tag]);
      });

      it("a change of kind records the owner as its source, whatever it was before", async () => {
        await h.seedTag(A, tagOf("solar", { kindSource: "asked" }));
        const tag = await changeTagKind(deps(), A, asProject);
        expect(tag).toMatchObject({ kind: "project", kindSource: "stated" });
        expect(await h.catalog(A)).toEqual([
          tagOf("solar", { kind: "project", kindSource: "stated" }),
        ]);
      });

      it("clears the done status in both directions, so a round trip reopens the project", async () => {
        await h.seedTag(A, tagOf("solar", { kind: "project", projectStatus: "done" }));
        expect((await filingContext(deps(), A)).activeProjects).toEqual([]);
        const topic = await changeTagKind(deps(), A, { name: "solar", kind: "topic" });
        expect(topic).toMatchObject({ kind: "topic", projectStatus: null });
        const project = await changeTagKind(deps(), A, asProject);
        expect(project).toMatchObject({ kind: "project", projectStatus: null });
        expect((await filingContext(deps(), A)).activeProjects.map((t) => t.key)).toEqual([
          "solar",
        ]);
      });

      it("writes nothing when the tag already has the kind and the owner stated it", async () => {
        const stated = tagOf("solar", {
          kind: "project",
          kindSource: "stated",
          projectStatus: "done",
        });
        await h.seedTag(A, stated);
        const counted = countingTagWrites(h.store);
        const tag = await changeTagKind({ store: counted.store }, A, asProject);
        expect(tag).toEqual(stated);
        expect(counted.calls()).toBe(0);
        expect(await h.catalog(A)).toEqual([stated]);
      });

      for (const guess of ["inferred", "asked"] as const) {
        it(`confirms a kind that was ${guess} without changing the kind or reopening a done project`, async () => {
          await h.seedTag(
            A,
            tagOf("solar", { kind: "project", kindSource: guess, projectStatus: "done" }),
          );
          const counted = countingTagWrites(h.store);
          const tag = await changeTagKind({ store: counted.store }, A, asProject);
          const confirmed = tagOf("solar", {
            kind: "project",
            kindSource: "stated",
            projectStatus: "done",
          });
          expect(tag).toEqual(confirmed);
          expect(counted.calls()).toBe(1);
          expect(await h.catalog(A)).toEqual([confirmed]);
          expect((await filingContext(deps(), A)).activeProjects).toEqual([]);
        });
      }

      it("a status change made between the read and the confirmation is kept", async () => {
        await h.seedTag(A, tagOf("solar", { kind: "project", projectStatus: "active" }));
        const tag = await changeTagKind({ store: racingStatusWrite(h.store) }, A, asProject);
        const expected = tagOf("solar", {
          kind: "project",
          kindSource: "stated",
          projectStatus: "done",
        });
        expect(tag).toEqual(expected);
        expect(await h.catalog(A)).toEqual([expected]);
      });

      it("a kind changed by someone else while confirming is a conflict, and nothing is confirmed", async () => {
        await h.seedTag(A, tagOf("solar", { kind: "project" }));
        const racing = racingTagWrite(h.store);
        expect(await code(changeTagKind({ store: racing }, A, asProject))).toBe("conflict");
        expect((await h.catalog(A)).map((t) => t.kindSource)).toEqual(["inferred"]);
      });

      it("refuses an unknown tag, a blank name and a bad kind without writing", async () => {
        await h.seedTag(A, tagOf("solar"));
        const counted = countingTagWrites(h.store);
        const deps2 = { store: counted.store };
        expect(await code(changeTagKind(deps2, A, { name: "nope", kind: "project" }))).toBe(
          "not_found",
        );
        expect(await code(changeTagKind(deps2, A, { name: "  ", kind: "project" }))).toBe(
          "invalid_input",
        );
        expect(
          await code(changeTagKind(deps2, A, { name: "solar", kind: "folder" as never })),
        ).toBe("invalid_input");
        expect(counted.calls()).toBe(0);
        expect(await h.catalog(A)).toEqual([tagOf("solar")]);
      });

      it("leaves another owner's tag with the same key alone", async () => {
        await h.seedTag(A, tagOf("solar"));
        await h.seedTag(B, tagOf("solar", { description: "b" }));
        await changeTagKind(deps(), A, asProject);
        expect(await h.catalog(B)).toEqual([tagOf("solar", { description: "b" })]);
      });

      it("keeps a concurrent change instead of overwriting it", async () => {
        await h.seedTag(A, tagOf("solar"));
        const tag = await changeTagKind({ store: racingTagWrite(h.store, 1) }, A, asProject);
        expect(tag).toMatchObject({ kind: "project", projectStatus: "done" });
        expect(await h.catalog(A)).toEqual([
          tagOf("solar", { kind: "project", kindSource: "stated", projectStatus: "done" }),
        ]);
      });
    });

    describe("LinkStore directly", () => {
      const patch = {
        summary: "changed",
        state: "archived" as const,
        tags: [
          {
            key: "newtag",
            name: "NewTag",
            source: "stated" as const,
            kind: "topic" as const,
            kindSource: "inferred" as const,
          },
        ],
      };
      const why: Labelled = { text: "filled", source: "stated" };
      const calls = {
        get: (s: LinkStore, id: string) => s.get(A, id),
        update: (s: LinkStore, id: string) => s.update(A, id, patch),
        fillWhyIfMissing: (s: LinkStore, id: string) => s.fillWhyIfMissing(A, id, why),
        updateIf: (s: LinkStore, id: string) => s.updateIf(A, id, {}, patch),
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

    describe("listLinks", () => {
      it("returns every link of the owner in every state, as get does, oldest id first", async () => {
        const first = await saveLink(deps(), A, {
          url: "https://ex.com/1",
          savedBy: "a",
          why: { text: "w", source: "asked" },
          tags: [
            { name: "Wind", source: "stated" },
            { name: "Solar", source: "stated" },
          ],
        });
        const second = await saveLink(deps(), A, { url: "https://ex.com/2", savedBy: "a" });
        const third = await saveLink(deps(), A, {
          url: "https://ex.com/3",
          savedBy: "a",
          tags: [{ name: "solar", source: "inferred" }],
        });
        await saveLink(deps(), B, { url: "https://ex.com/b", savedBy: "b" });
        await updateLink(deps(), A, second.link.id, { state: "archived" });
        // A catalog change after attaching must show, as it does through get.
        await h.store.updateTag(A, "solar", { kind: "project", kindSource: "stated" }, "topic");

        const listed = await h.store.listLinks(A);

        const ids = [first.link.id, second.link.id, third.link.id];
        expect(listed.map((l) => l.id)).toEqual(ids);
        expect(listed).toEqual(await Promise.all(ids.map((id) => h.store.get(A, id))));
        expect(listed[0]?.tags.map((t) => t.key)).toEqual(["wind", "solar"]);
        expect(listed[1]?.state).toBe("archived");
        expect(listed[2]?.tags).toEqual([
          {
            key: "solar",
            name: "Solar",
            source: "inferred",
            kind: "project",
            kindSource: "stated",
          },
        ]);
      });

      it("never returns another owner's links, and an owner with none gets []", async () => {
        await saveLink(deps(), B, { url: "https://ex.com/b", savedBy: "b" });
        expect(await h.store.listLinks(A)).toEqual([]);
        expect(await h.store.listLinks("nobody")).toEqual([]);
        expect((await h.store.listLinks(B)).map((l) => l.url)).toEqual(["https://ex.com/b"]);
      });
    });

    describe("claimSurfaced", () => {
      const now = new Date("2026-03-01T00:00:00Z");
      const cutoff = new Date(now.getTime() - 14 * 86_400_000);
      const when = { at: now, notSurfacedAfter: cutoff, now };
      const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

      /** Insert straight through the store, so lastSurfacedAt can be seeded. */
      const insert = async (owner: string, n: number, over: Partial<Link> = {}) =>
        (
          await h.store.insertIfAbsent(owner, {
            url: `https://ex.com/${n}`,
            urlKey: `https://ex.com/${n}`,
            title: null,
            summary: null,
            summarySource: null,
            why: null,
            tags: [],
            savedAt: new Date("2026-01-01T00:00:00Z"),
            savedBy: "t",
            lastOpenedAt: null,
            lastSurfacedAt: null,
            snoozedUntil: null,
            putAwayAt: null,
            tidyKeptAt: null,
            state: "active",
            ...over,
          })
        ).link;

      it("claims only active, unsnoozed links outside the cutoff, at the exact boundaries, in input order", async () => {
        const never = await insert(A, 1);
        const atCutoff = await insert(A, 2, { lastSurfacedAt: cutoff });
        const inside = await insert(A, 3, { lastSurfacedAt: ms(cutoff, 1) });
        const snoozeEnded = await insert(A, 4, { snoozedUntil: now });
        const snoozed = await insert(A, 5, { snoozedUntil: ms(now, 1) });
        const archived = await insert(A, 6, { state: "archived" });
        const theirs = await insert(B, 7);
        const absent = theirs.id.replace(/\d+$/, (n) => String(Number(n) + 1000));
        const beforeB = structuredClone(await h.all(B));

        const claimed = await h.store.claimSurfaced(
          A,
          [
            snoozed.id,
            snoozeEnded.id,
            never.id,
            atCutoff.id,
            inside.id,
            archived.id,
            theirs.id,
            absent,
            "zzz",
            "",
            never.id,
          ],
          when,
        );

        expect(claimed.map((c) => [c.link.id, c.previousSurfacedAt])).toEqual([
          [snoozeEnded.id, null],
          [never.id, null],
          [atCutoff.id, cutoff],
        ]);
        for (const c of claimed) {
          expect(c.link.lastSurfacedAt).toEqual(now);
          expect(c.link).toEqual(await h.store.get(A, c.link.id));
        }
        expect((await h.store.get(A, inside.id))?.lastSurfacedAt).toEqual(ms(cutoff, 1));
        expect((await h.store.get(A, snoozed.id))?.lastSurfacedAt).toBeNull();
        expect((await h.store.get(A, archived.id))?.lastSurfacedAt).toBeNull();
        expect(await h.all(B)).toEqual(beforeB);
      });

      it("reads back the link as it is at the claim, with tags from the catalog", async () => {
        const { link } = await saveLink(deps(), A, {
          url: "https://ex.com/a",
          savedBy: "a",
          tags: [{ name: "Solar", source: "stated" }],
        });
        await updateLink(deps(), A, link.id, { why: { text: "late", source: "asked" } });
        await h.store.updateTag(A, "solar", { kind: "project" }, "topic");

        const [claim] = await h.store.claimSurfaced(A, [link.id], when);

        expect(claim?.link.why).toEqual({ text: "late", source: "asked" });
        expect(claim?.link.tags.map((t) => t.kind)).toEqual(["project"]);
        expect(claim?.link.snapshot?.status).toBe("pending");
      });

      it("makes two claims over the same links disjoint, even when they start together", async () => {
        const links = await Promise.all([1, 2, 3, 4].map((n) => insert(A, n)));
        const ids = links.map((l) => l.id);

        const [one, two] = await Promise.all([
          h.store.claimSurfaced(A, ids, when),
          h.store.claimSurfaced(A, [...ids].reverse(), when),
        ]);
        const got = [...(one ?? []), ...(two ?? [])].map((c) => c.link.id);

        expect([...got].sort()).toEqual([...ids].sort());
        expect(await h.store.claimSurfaced(A, ids, when)).toEqual([]);
      });

      describe("with an expected putAwayAt", () => {
        const away = new Date("2026-02-20T00:00:00Z");
        const expecting = { ...when, expectedPutAwayAt: away };
        const claimIds = async (owner: string, ids: string[], w = expecting) =>
          (await h.store.claimSurfaced(owner, ids, w)).map((c) => c.link.id);

        it("claims only an archived link carrying exactly that marker, for its owner", async () => {
          const match = await insert(A, 1, { state: "archived", putAwayAt: away });
          const other = await insert(A, 2, { state: "archived", putAwayAt: ms(away, 1) });
          const stale = await insert(A, 3, { state: "archived" });
          const active = await insert(A, 4);
          const theirs = await insert(B, 5, { state: "archived", putAwayAt: away });

          expect(await claimIds(A, [other.id, stale.id, active.id, theirs.id])).toEqual([]);
          for (const l of [other, stale, active]) {
            expect((await h.store.get(A, l.id))?.lastSurfacedAt, l.id).toBeNull();
          }
          expect((await h.store.get(B, theirs.id))?.lastSurfacedAt).toBeNull();

          const [claim] = await h.store.claimSurfaced(A, [match.id], expecting);
          expect(claim?.link.id).toBe(match.id);
          expect(claim?.previousSurfacedAt).toBeNull();
          expect((await h.store.get(A, match.id))?.lastSurfacedAt).toEqual(now);
        });

        it("is blocked by a surfacing since the marker inside the cooldown, not by one before the marker or one older than the cooldown", async () => {
          const before = await insert(A, 1, {
            state: "archived",
            putAwayAt: away,
            lastSurfacedAt: ms(cutoff, 1), // inside the cooldown, but before the marker
          });
          const since = await insert(A, 2, {
            state: "archived",
            putAwayAt: away,
            lastSurfacedAt: away, // at the marker, inside the cooldown
          });
          const oldAway = ms(cutoff, -2 * 86_400_000);
          const sinceOld = await insert(A, 3, {
            state: "archived",
            putAwayAt: oldAway,
            lastSurfacedAt: ms(cutoff, -86_400_000), // after the marker, outside the cooldown
          });
          expect(await claimIds(A, [before.id, since.id])).toEqual([before.id]);
          expect(await claimIds(A, [sinceOld.id], { ...when, expectedPutAwayAt: oldAway })).toEqual(
            [sinceOld.id],
          );
          expect((await h.store.get(A, since.id))?.lastSurfacedAt).toEqual(away);
        });

        it("skips a snoozed link", async () => {
          const snoozed = await insert(A, 1, {
            state: "archived",
            putAwayAt: away,
            snoozedUntil: ms(now, 1),
          });
          expect(await claimIds(A, [snoozed.id])).toEqual([]);
          expect((await h.store.get(A, snoozed.id))?.lastSurfacedAt).toBeNull();
        });

        it("does not apply after Bring it back and putting it away again", async () => {
          const link = await insert(A, 1, { state: "archived", putAwayAt: away });
          await h.store.update(A, link.id, { state: "active", putAwayAt: null });
          await h.store.update(A, link.id, { state: "archived", putAwayAt: ms(away, 5) });
          expect(await claimIds(A, [link.id])).toEqual([]);
          expect((await h.store.get(A, link.id))?.lastSurfacedAt).toBeNull();
        });
      });

      it("claims nothing for an empty list, and never for another owner", async () => {
        const mine = await insert(A, 1);
        expect(await h.store.claimSurfaced(A, [], when)).toEqual([]);
        expect(await h.store.claimSurfaced(B, [mine.id], when)).toEqual([]);
        expect((await h.store.get(A, mine.id))?.lastSurfacedAt).toBeNull();
      });
    });

    describe("unclaimSurfaced", () => {
      const at = new Date("2026-03-01T10:20:30.456Z");
      const earlier = new Date("2026-02-01T00:00:00.000Z");
      const insert = async (owner: string, n: number, lastSurfacedAt: Date | null) =>
        (
          await h.store.insertIfAbsent(owner, {
            url: `https://ex.com/${n}`,
            urlKey: `https://ex.com/${n}`,
            title: null,
            summary: null,
            summarySource: null,
            why: null,
            tags: [],
            savedAt: new Date("2026-01-01T00:00:00Z"),
            savedBy: "t",
            lastOpenedAt: null,
            lastSurfacedAt,
            snoozedUntil: null,
            putAwayAt: null,
            tidyKeptAt: null,
            state: "active",
          })
        ).link;

      it("puts back the previous value, null or a date, while lastSurfacedAt is still the claim's", async () => {
        const never = await insert(A, 1, at);
        const before = await insert(A, 2, at);
        expect(
          await h.store.unclaimSurfaced(A, never.id, { at: new Date(at), previous: null }),
        ).toBe(true);
        expect(await h.store.unclaimSurfaced(A, before.id, { at, previous: earlier })).toBe(true);
        expect(await h.store.get(A, never.id)).toEqual({ ...never, lastSurfacedAt: null });
        expect(await h.store.get(A, before.id)).toEqual({ ...before, lastSurfacedAt: earlier });
      });

      it("writes nothing once lastSurfacedAt moved on, even by a millisecond, or was never set", async () => {
        const later = await insert(A, 1, new Date(at.getTime() + 1));
        const unset = await insert(A, 2, null);
        const before = structuredClone(await h.all(A));
        expect(await h.store.unclaimSurfaced(A, later.id, { at, previous: earlier })).toBe(false);
        expect(await h.store.unclaimSurfaced(A, unset.id, { at, previous: earlier })).toBe(false);
        expect(await h.all(A)).toEqual(before);
      });

      it("never touches another owner's link, and an unknown or malformed id is false", async () => {
        const theirs = await insert(B, 1, at);
        const mine = await insert(A, 2, at);
        const absent = theirs.id.replace(/\d+$/, (n) => String(Number(n) + 1000));
        const before = [structuredClone(await h.all(A)), structuredClone(await h.all(B))];
        for (const id of [theirs.id, absent, "zzz", "", "9223372036854775808"]) {
          expect(await h.store.unclaimSurfaced(A, id, { at, previous: null }), id).toBe(false);
        }
        expect(await h.store.unclaimSurfaced(B, mine.id, { at, previous: null })).toBe(false);
        expect([await h.all(A), await h.all(B)]).toEqual(before);
      });
    });

    describe("summary source", () => {
      const seed = async (n: number, over: Partial<Link> = {}) =>
        (
          await h.store.insertIfAbsent(A, {
            url: `https://ex.com/s${n}`,
            urlKey: `https://ex.com/s${n}`,
            title: "t",
            summary: null,
            summarySource: null,
            why: null,
            tags: [],
            savedAt: new Date("2026-01-01T00:00:00Z"),
            savedBy: "t",
            lastOpenedAt: null,
            lastSurfacedAt: null,
            snoozedUntil: null,
            putAwayAt: null,
            tidyKeptAt: null,
            state: "active",
            ...over,
          })
        ).link;
      const pair = async (id: string) => {
        const l = await h.store.get(A, id);
        return [l?.summary, l?.summarySource];
      };

      it("keeps a summary's source through insert, get and update", async () => {
        const link = await seed(1, { summary: "S", summarySource: "inferred" });
        expect(await pair(link.id)).toEqual(["S", "inferred"]);
        const set = await h.store.update(A, link.id, { summary: "T", summarySource: "stated" });
        expect([set?.summary, set?.summarySource]).toEqual(["T", "stated"]);
        const cleared = await h.store.update(A, link.id, { summary: null, summarySource: null });
        expect([cleared?.summary, cleared?.summarySource]).toEqual([null, null]);
      });

      it("summaryOver skips the summary but writes the rest", async () => {
        const patch = {
          title: "T",
          summary: "AI",
          summarySource: "inferred" as const,
          summaryOver: [null, "inferred" as const],
        };
        const writes = [
          (id: string) => h.store.update(A, id, patch),
          (id: string) => h.store.updateWithReceipt(A, id, patch, clock),
          (id: string) => h.store.updateIf(A, id, {}, patch),
        ];
        for (const [i, write] of writes.entries()) {
          const link = await seed(10 + i, { summary: "Mine", summarySource: "stated" });
          await write(link.id);
          expect((await h.store.get(A, link.id))?.title, `write ${i}`).toBe("T");
          expect(await pair(link.id), `write ${i}`).toEqual(["Mine", "stated"]);
        }
        const wrote = await seed(20, { summary: "Mine", summarySource: "stated" });
        expect((await h.store.updateWithReceipt(A, wrote.id, patch, clock))?.editId).not.toBeNull();
        const nothing = await seed(21, { title: "T", summary: "Mine", summarySource: "server" });
        expect((await h.store.updateWithReceipt(A, nothing.id, patch, clock))?.editId).toBeNull();
      });

      it("summaryOver applies over no label and over no summary", async () => {
        const unlabelled = await seed(30, { summary: "Old", summarySource: null });
        const empty = await seed(31);
        for (const link of [unlabelled, empty]) {
          await h.store.update(A, link.id, {
            summary: "AI",
            summarySource: "inferred",
            summaryOver: [null, "inferred"],
          });
          expect(await pair(link.id)).toEqual(["AI", "inferred"]);
        }
      });

      it("updateIf matches an unlabelled summary", async () => {
        const link = await seed(40, { summary: "Old", summarySource: null });
        const result = await h.store.updateIf(
          A,
          link.id,
          { summary: "Old", summarySource: [null] },
          { summary: "New", summarySource: "server" },
        );
        expect(result?.applied).toBe(true);
        expect(await pair(link.id)).toEqual(["New", "server"]);
      });

      it("updateIf refuses when the summary or its source changed", async () => {
        const expected = { summary: "S", summarySource: ["inferred" as const] };
        const held = [
          ["S", "stated"],
          ["S2", "inferred"],
        ] as const;
        for (const [i, [summary, summarySource]] of held.entries()) {
          const link = await seed(50 + i, { summary, summarySource });
          const result = await h.store.updateIf(A, link.id, expected, {
            summary: "New",
            summarySource: "server",
          });
          expect(result?.applied, summary).toBe(false);
          expect(await pair(link.id)).toEqual([summary, summarySource]);
        }
      });
    });

    describe("summary precedence", () => {
      const held = async (summary: string, summarySource: SummarySource) => {
        const { link } = await saveLink(deps(), A, { url: "https://ex.com/p", savedBy: "t" });
        await h.store.update(A, link.id, { summary, summarySource });
        return link.id;
      };
      const pair = async (id: string) => {
        const l = await getLink(deps(), A, id);
        return [l.summary, l.summarySource];
      };

      it("saves a plain-text summary as inferred, and a labelled one as labelled", async () => {
        const plain = await saveLink(deps(), A, {
          url: "https://ex.com/1",
          savedBy: "t",
          summary: " Plain ",
        });
        expect([plain.link.summary, plain.link.summarySource]).toEqual(["Plain", "inferred"]);
        const asked = await saveLink(deps(), A, {
          url: "https://ex.com/2",
          savedBy: "t",
          summary: { text: "Theirs", source: "asked" },
        });
        expect([asked.link.summary, asked.link.summarySource]).toEqual(["Theirs", "asked"]);
        const none = await saveLink(deps(), A, { url: "https://ex.com/3", savedBy: "t" });
        expect([none.link.summary, none.link.summarySource]).toEqual([null, null]);
      });

      it.each([
        ["the server's", "Srv", "server"],
        ["the owner's", "Mine", "stated"],
        ["an asked-for", "Asked", "asked"],
      ] as const)("an AI's summary doesn't replace %s", async (_n, summary, source) => {
        const id = await held(summary, source);
        await updateLink(deps(), A, id, { title: "Other", summary: "AI" });
        expect((await getLink(deps(), A, id)).title).toBe("Other");
        expect(await pair(id)).toEqual([summary, source]);
        await updateLinkWithReceipt(deps(), A, id, { summary: { text: "AI", source: "inferred" } });
        expect(await pair(id)).toEqual([summary, source]);
      });

      it("an AI's summary fills a gap and replaces its own and an unlabelled one", async () => {
        const { link } = await saveLink(deps(), A, { url: "https://ex.com/q", savedBy: "t" });
        await updateLink(deps(), A, link.id, { summary: "First" });
        expect(await pair(link.id)).toEqual(["First", "inferred"]);
        await updateLink(deps(), A, link.id, { summary: "Second" });
        expect(await pair(link.id)).toEqual(["Second", "inferred"]);
        await h.store.update(A, link.id, { summary: "Old" });
        await updateLink(deps(), A, link.id, { summary: "Third" });
        expect(await pair(link.id)).toEqual(["Third", "inferred"]);
      });

      it("an owner's summary replaces the server's", async () => {
        const id = await held("Srv", "server");
        await updateLink(deps(), A, id, { summary: { text: "Mine", source: "stated" } });
        expect(await pair(id)).toEqual(["Mine", "stated"]);
      });

      it("null and a blank owner summary clear text and source, over anything", async () => {
        for (const cleared of [
          null,
          { text: " ", source: "stated" as const },
          { text: "", source: "asked" as const },
        ]) {
          const id = await held("Mine", "stated");
          await updateLink(deps(), A, id, { summary: cleared });
          expect(await pair(id), JSON.stringify(cleared)).toEqual([null, null]);
        }
      });

      it("a blank summary from an AI clears only another AI's", async () => {
        for (const blank of ["", "  ", { text: " ", source: "inferred" as const }]) {
          for (const [text, source] of [
            ["Mine", "stated"],
            ["Asked", "asked"],
            ["Srv", "server"],
          ] as const) {
            const id = await held(text, source);
            await updateLink(deps(), A, id, { summary: blank });
            expect(await pair(id), `${JSON.stringify(blank)} over ${source}`).toEqual([
              text,
              source,
            ]);
          }
          const id = await held("AI", "inferred");
          await updateLink(deps(), A, id, { summary: blank });
          expect(await pair(id), JSON.stringify(blank)).toEqual([null, null]);
        }
      });

      it("a repeat save ignores the summary", async () => {
        const id = await held("Srv", "server");
        await saveLink(deps(), A, {
          url: "https://ex.com/p",
          savedBy: "t",
          summary: { text: "Again", source: "stated" },
        });
        expect(await pair(id)).toEqual(["Srv", "server"]);
      });

      it("refuses a summary source that is not stated, asked or inferred", async () => {
        const id = await held("Srv", "server");
        const bad = { text: "x", source: "server" } as unknown as { text: string; source: "asked" };
        expect(await code(updateLink(deps(), A, id, { summary: bad }))).toBe("invalid_input");
        const save = saveLink(deps(), A, { url: "https://ex.com/z", savedBy: "t", summary: bad });
        expect(await code(save)).toBe("invalid_input");
        expect(await pair(id)).toEqual(["Srv", "server"]);
      });
    });

    describe("updateIf", () => {
      const snoozed = new Date("2026-04-01T10:20:30.456Z");
      const seed = async (owner: string, n: number, over: Partial<Link> = {}) =>
        (
          await h.store.insertIfAbsent(owner, {
            url: `https://ex.com/${n}`,
            urlKey: `https://ex.com/${n}`,
            title: "t",
            summary: null,
            summarySource: null,
            why: null,
            tags: [],
            savedAt: new Date("2026-01-01T00:00:00Z"),
            savedBy: "t",
            lastOpenedAt: null,
            lastSurfacedAt: null,
            snoozedUntil: null,
            putAwayAt: null,
            tidyKeptAt: null,
            state: "active",
            ...over,
          })
        ).link;

      it("applies the patch while state and snoozedUntil still match, and says so", async () => {
        const link = await seed(A, 1, { state: "archived", snoozedUntil: snoozed });
        const result = await h.store.updateIf(
          A,
          link.id,
          { state: "archived", snoozedUntil: new Date(snoozed) },
          { state: "active", snoozedUntil: null },
        );
        expect(result?.applied).toBe(true);
        expect(result?.link).toMatchObject({ state: "active", snoozedUntil: null });
        expect(await h.store.get(A, link.id)).toEqual(result?.link);
      });

      it("writes nothing once a field moved on, and returns the link as it is", async () => {
        const link = await seed(A, 1, { state: "archived", snoozedUntil: snoozed });
        const before = await h.store.get(A, link.id);
        const later = new Date(snoozed.getTime() + 1);
        for (const expected of [
          { state: "active" as const },
          { snoozedUntil: later },
          { snoozedUntil: null },
          { state: "archived" as const, snoozedUntil: later },
        ]) {
          const result = await h.store.updateIf(A, link.id, expected, { title: "changed" });
          expect(result, JSON.stringify(expected)).toEqual({ link: before, applied: false });
        }
        expect(await h.store.get(A, link.id)).toEqual(before);
      });

      it("matches a why only by its source, with null for no why", async () => {
        const none = await seed(A, 1);
        const guess = await seed(A, 2, { why: { text: "g", source: "inferred" } });
        const said = await seed(A, 3, { why: { text: "s", source: "stated" } });
        const asked = await seed(A, 4, { why: { text: "a", source: "asked" } });
        const answer: Labelled = { text: "mine", source: "asked" };
        const results = [];
        for (const link of [none, guess, said, asked]) {
          const result = await h.store.updateIf(
            A,
            link.id,
            { whySource: [null, "inferred"] },
            { why: answer },
          );
          results.push(result?.applied);
        }
        expect(results).toEqual([true, true, false, false]);
        expect((await h.store.get(A, none.id))?.why).toEqual(answer);
        expect((await h.store.get(A, guess.id))?.why).toEqual(answer);
        expect((await h.store.get(A, said.id))?.why).toEqual({ text: "s", source: "stated" });
        expect((await h.store.get(A, asked.id))?.why).toEqual({ text: "a", source: "asked" });
      });

      it("starts a new link with no put-away date and no Keep date, and update sets and clears each", async () => {
        const saved = await saveLink(deps(), A, { url: "https://ex.com/new", savedBy: "t" });
        expect(saved.link).toMatchObject({ putAwayAt: null, tidyKeptAt: null });
        const link = await seed(A, 1);
        const date = new Date("2026-05-06T07:08:09.123Z");
        const set = await h.store.update(A, link.id, { putAwayAt: date });
        expect(set).toMatchObject({ putAwayAt: date, tidyKeptAt: null });
        const both = await h.store.update(A, link.id, { tidyKeptAt: date });
        expect(both).toMatchObject({ putAwayAt: date, tidyKeptAt: date });
        const cleared = await h.store.update(A, link.id, { putAwayAt: null });
        expect(cleared).toMatchObject({ putAwayAt: null, tidyKeptAt: date });
        const clearedKept = await h.store.update(A, link.id, { tidyKeptAt: null });
        expect(clearedKept).toMatchObject({ putAwayAt: null, tidyKeptAt: null });
        expect(await h.store.get(A, link.id)).toEqual(clearedKept);
      });

      it("expects putAwayAt to the millisecond, null meaning not set, and writes nothing on a mismatch", async () => {
        const date = new Date("2026-05-06T07:08:09.123Z");
        const away = await seed(A, 1, { state: "archived", putAwayAt: date });
        const stale = await seed(A, 2, { state: "archived" });
        const before = structuredClone(await h.all(A));
        for (const [link, expected] of [
          [away, { putAwayAt: null }],
          [away, { putAwayAt: new Date(date.getTime() + 1) }],
          [stale, { putAwayAt: date }],
        ] as const) {
          const result = await h.store.updateIf(A, link.id, expected, { state: "active" });
          expect(result?.applied, JSON.stringify(expected)).toBe(false);
        }
        expect(await h.all(A)).toEqual(before);
        const matched = await h.store.updateIf(
          A,
          away.id,
          { putAwayAt: new Date(date) },
          { state: "active", putAwayAt: null },
        );
        expect(matched?.applied).toBe(true);
        expect(matched?.link).toMatchObject({ state: "active", putAwayAt: null });
        const none = await h.store.updateIf(A, stale.id, { putAwayAt: null }, { title: "x" });
        expect(none?.applied).toBe(true);
      });

      it("never matches another owner's link: null, and that link is unchanged", async () => {
        const theirs = await seed(B, 1, { state: "archived" });
        const before = structuredClone(await h.all(B));
        expect(
          await h.store.updateIf(A, theirs.id, { state: "archived" }, { state: "active" }),
        ).toBeNull();
        expect(await h.all(B)).toEqual(before);
      });
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
        expect(updated.tags).toEqual([
          {
            key: "new tag",
            name: "New Tag",
            source: "inferred",
            kind: "topic",
            kindSource: "inferred",
          },
        ]);
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

      it("sets, keeps and clears the title like the summary", async () => {
        const { link } = await saveLink(deps(), A, {
          url: "https://ex.com/a",
          title: "old",
          summary: "s",
          savedBy: "agent",
        });
        const set = await updateLink(deps(), A, link.id, { title: "new" });
        expect(set.title).toBe("new");
        expect(set.summary).toBe("s");
        const kept = await updateLink(deps(), A, link.id, { summary: "s2" });
        expect(kept.title).toBe("new");
        const cleared = await updateLink(deps(), A, link.id, { title: null });
        expect(cleared.title).toBeNull();
        expect(cleared.summary).toBe("s2");
        expect((await h.all(A))[0]?.title).toBeNull();
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

      describe("savePage", () => {
        const URL_A = "https://ex.com/a";
        const page = (over: Partial<SavePageInput> = {}): SavePageInput => ({
          url: URL_A,
          title: "A page",
          why: null,
          savedBy: "web",
          ...over,
        });

        it("saves a new link with the owner's why as asked, by the caller's savedBy", async () => {
          const { link, created, whyKept } = await savePage(
            deps(),
            A,
            page({ why: "  for the trip " }),
          );
          expect(created).toBe(true);
          expect(whyKept).toBe(true);
          expect(link).toMatchObject({
            title: "A page",
            why: { text: "for the trip", source: "asked" },
          });
          expect(await h.all(A)).toMatchObject([
            {
              url: URL_A,
              title: "A page",
              why: { text: "for the trip", source: "asked" },
              savedBy: "web",
              state: "active",
            },
          ]);
        });

        it("stores no why for a blank one, and no title for a blank one", async () => {
          const { link, whyKept } = await savePage(deps(), A, page({ why: "   ", title: "  " }));
          expect(link.why).toBeNull();
          expect(link.title).toBeNull();
          expect(whyKept).toBe(true);
        });

        it("refuses a title of 201 code points and writes no link", async () => {
          expect(await code(savePage(deps(), A, page({ title: "😀".repeat(201) })))).toBe(
            "invalid_input",
          );
          expect(await h.all(A)).toEqual([]);
        });

        it.each(["ftp://ex.com/a", "https://user:pw@ex.com/a"])(
          "refuses %s as invalid_url and writes no link",
          async (url) => {
            expect(await code(savePage(deps(), A, page({ url })))).toBe("invalid_url");
            expect(await h.all(A)).toEqual([]);
          },
        );

        it("a repeat save returns the same link, fills a missing why, and keeps its title", async () => {
          const first = await savePage(deps(), A, page());
          const again = await savePage(deps(), A, page({ title: "Other", why: "to cook" }));
          expect(again.created).toBe(false);
          expect(again.link.id).toBe(first.link.id);
          expect(again.link.why).toEqual({ text: "to cook", source: "asked" });
          expect(again.link.title).toBe("A page");
          expect(again.whyKept).toBe(true);
          expect(await h.all(A)).toHaveLength(1);
        });

        it("over an agent's guess, a repeat save replaces it with the owner's why", async () => {
          await saveLink(deps(), A, {
            url: URL_A,
            savedBy: "agent",
            why: { text: "guess", source: "inferred" },
          });
          const again = await savePage(deps(), A, page({ why: "mine" }));
          expect(again.whyKept).toBe(true);
          expect(again.link.why).toEqual({ text: "mine", source: "asked" });
          expect((await h.all(A))[0]?.why).toEqual({ text: "mine", source: "asked" });
        });

        it.each(["stated", "asked"] as const)(
          "over a %s why, a repeat save keeps it and says the owner's was not kept",
          async (source) => {
            await saveLink(deps(), A, {
              url: URL_A,
              savedBy: "agent",
              why: { text: "theirs", source },
            });
            const again = await savePage(deps(), A, page({ why: "mine" }));
            expect(again.whyKept).toBe(false);
            expect(again.link.why).toEqual({ text: "theirs", source });
            expect((await h.all(A))[0]?.why).toEqual({ text: "theirs", source });
          },
        );

        it("a repeat save with no why leaves a guess alone and counts as kept", async () => {
          await saveLink(deps(), A, {
            url: URL_A,
            savedBy: "agent",
            why: { text: "guess", source: "inferred" },
          });
          const again = await savePage(deps(), A, page());
          expect(again.whyKept).toBe(true);
          expect((await h.all(A))[0]?.why).toEqual({ text: "guess", source: "inferred" });
        });

        it("keeps a reason given between its read and its write, and says the owner's was not kept", async () => {
          await saveLink(deps(), A, {
            url: URL_A,
            savedBy: "agent",
            why: { text: "guess", source: "inferred" },
          });
          const store = wrap(h.store, {
            async updateIf(owner, id, expected, patch) {
              await h.store.update(owner, id, {
                why: { text: "given meanwhile", source: "stated" },
              });
              return h.store.updateIf(owner, id, expected, patch);
            },
          });
          const again = await savePage({ store, now: () => clock }, A, page({ why: "mine" }));
          expect(again.created).toBe(false);
          expect(again.whyKept).toBe(false);
          expect(again.link.why).toEqual({ text: "given meanwhile", source: "stated" });
          expect((await h.all(A))[0]?.why).toEqual({ text: "given meanwhile", source: "stated" });
        });

        it("does not wait for the page: a kick that never settles does not hold it, and still runs", async () => {
          const kicks: [string, string][] = [];
          const never = {
            kick: (owner: string, id: string) => {
              kicks.push([owner, id]);
              return new Promise<void>(() => {});
            },
          };
          let timer: ReturnType<typeof setTimeout> | undefined;
          const waited = new Promise<"waited">((resolve) => {
            timer = setTimeout(() => resolve("waited"), 1_000);
          });
          try {
            const result = await Promise.race([
              savePage({ ...deps(), snapshots: never }, A, page()),
              waited,
            ]);
            expect(result).not.toBe("waited");
            expect(kicks).toEqual([[A, (await h.all(A))[0]?.id]]);
          } finally {
            clearTimeout(timer);
          }
        });

        it("leaves another owner's link with the same address untouched", async () => {
          await saveLink(deps(), A, {
            url: URL_A,
            savedBy: "agent",
            title: "A's",
            why: { text: "A's reason", source: "stated" },
          });
          const before = structuredClone(await h.all(A));
          const theirs = await savePage(deps(), B, page({ why: "B's reason" }));
          expect(theirs.created).toBe(true);
          expect(theirs.whyKept).toBe(true);
          expect(theirs.link.why).toEqual({ text: "B's reason", source: "asked" });
          expect(await h.all(A)).toEqual(before);
          expect(await h.all(B)).toHaveLength(1);
        });
      });
    });

    describe("events", () => {
      const T1 = new Date("2026-05-01T10:00:00.000Z");
      const T2 = new Date("2026-05-01T09:00:00.000Z");
      const seed = async (owner: string, n: number) =>
        (await saveLink(deps(), owner, { url: `https://ex.com/ev${n}`, savedBy: "t" })).link.id;
      const log = async (owner: string, id: string) => await h.eventsOf(owner, id);
      const badKind = "nonsense" as LinkEventKind;
      const row = (kind: LinkEventKind, at: Date) => ({ kind, at, backfilled: false });

      it("update records the events it is given", async () => {
        const id = await seed(A, 1);
        await h.store.update(A, id, { title: "x" }, [
          { record: "opened", at: T1 },
          { record: "put_away", at: T2 },
        ]);
        expect(await log(A, id)).toEqual([row("opened", T1), row("put_away", T2)]);
      });

      it("updateIf records nothing when it is not applied", async () => {
        const id = await seed(A, 1);
        const refused = await h.store.updateIf(A, id, { state: "archived" }, { title: "x" }, [
          { record: "put_away", at: T1 },
        ]);
        expect(refused?.applied).toBe(false);
        expect(await log(A, id)).toEqual([]);
        const applied = await h.store.updateIf(A, id, { state: "active" }, { title: "x" }, [
          { record: "put_away", at: T1 },
        ]);
        expect(applied?.applied).toBe(true);
        expect(await log(A, id)).toEqual([row("put_away", T1)]);
      });

      it("unrecord removes only the event at its time", async () => {
        const id = await seed(A, 1);
        await h.store.update(A, id, {}, [
          { record: "stale", at: T1 },
          { record: "stale", at: T2 },
          { record: "opened", at: T2 },
        ]);
        await h.store.update(A, id, {}, [{ unrecord: "stale", at: T2 }]);
        expect(await log(A, id)).toEqual([row("stale", T1), row("opened", T2)]);
        await h.store.update(A, id, {}, [{ unrecord: "stale", at: T2 }]);
        expect(await log(A, id)).toEqual([row("stale", T1), row("opened", T2)]);
      });

      it("unrecord removes one row when two share the time", async () => {
        const id = await seed(A, 1);
        await h.store.update(A, id, {}, [
          { record: "opened", at: T1 },
          { record: "opened", at: T1 },
        ]);
        await h.store.update(A, id, {}, [{ unrecord: "opened", at: T1 }]);
        expect(await log(A, id)).toEqual([row("opened", T1)]);
      });

      it("record unlessBefore skips when the row already matched", async () => {
        const id = await seed(A, 1);
        await h.store.update(A, id, { state: "archived" });
        await h.store.update(A, id, {}, [
          { record: "put_away", at: T1, unlessBefore: { state: "archived" } },
        ]);
        expect(await log(A, id)).toEqual([]);
      });

      it("record unlessBefore records when it did not", async () => {
        const id = await seed(A, 1);
        await h.store.update(A, id, { state: "archived" }, [
          { record: "put_away", at: T1, unlessBefore: { state: "archived" } },
        ]);
        expect(await log(A, id)).toEqual([row("put_away", T1)]);
      });

      it("a failed event write rolls back the link write", async () => {
        const id = await seed(A, 1);
        const before = await h.store.get(A, id);
        const bad = [{ record: badKind, at: T1 }];
        await expect(h.store.update(A, id, { title: "changed" }, bad)).rejects.toThrow();
        await expect(h.store.updateIf(A, id, {}, { title: "changed" }, bad)).rejects.toThrow();
        await expect(
          h.store.updateWithReceipt(A, id, { title: "changed" }, T1, undefined, bad),
        ).rejects.toThrow();
        expect(await h.store.get(A, id)).toEqual(before);
        expect(await log(A, id)).toEqual([]);
      });

      it("updateWithReceipt records its events when no covered field changed", async () => {
        const id = await seed(A, 1);
        const result = await h.store.updateWithReceipt(A, id, { lastOpenedAt: T1 }, T1, undefined, [
          { record: "opened", at: T1 },
        ]);
        expect(result?.editId).toBeNull();
        expect(await log(A, id)).toEqual([row("opened", T1)]);
      });

      it("a write without events leaves the log alone", async () => {
        const id = await seed(A, 1);
        await h.store.update(A, id, {}, [{ record: "opened", at: T1 }]);
        await h.store.update(A, id, { title: "a" });
        await h.store.updateIf(A, id, {}, { title: "b" });
        await h.store.updateWithReceipt(A, id, { title: "c" }, T1);
        expect(await log(A, id)).toEqual([row("opened", T1)]);
      });

      it("events for another owner's link are not written", async () => {
        const id = await seed(A, 1);
        const events = [{ record: "opened" as const, at: T1 }];
        expect(await h.store.update(B, id, { title: "x" }, events)).toBeNull();
        expect(await h.store.updateIf(B, id, {}, { title: "x" }, events)).toBeNull();
        expect(
          await h.store.updateWithReceipt(B, id, { title: "x" }, T1, undefined, events),
        ).toBeNull();
        expect(await log(A, id)).toEqual([]);
        expect(await log(B, id)).toEqual([]);
      });
    });

    describe("deleted links", () => {
      const twoLinks = async () => {
        const gone = await saveLink(deps(), A, { url: "https://ex.com/gone", savedBy: "t" });
        const kept = await saveLink(deps(), A, { url: "https://ex.com/kept", savedBy: "t" });
        await h.store.markDeleted(A, gone.link.id, clock);
        return { gone: gone.link.id, kept: kept.link.id };
      };

      it("a hidden link is absent from get and listLinks, and other links are not", async () => {
        const { gone, kept } = await twoLinks();
        expect(await h.store.get(A, gone)).toBeNull();
        expect((await h.store.listLinks(A)).map((l) => l.id)).toEqual([kept]);
        expect(await h.store.get(A, kept)).not.toBeNull();
      });

      it("claimSurfaced claims the other links and skips a hidden one", async () => {
        const { gone, kept } = await twoLinks();
        const at = new Date("2026-03-01T00:00:00Z");
        const claimed = await h.store.claimSurfaced(A, [gone, kept], {
          at,
          notSurfacedAfter: at,
          now: at,
        });
        expect(claimed.map((c) => c.link.id)).toEqual([kept]);
      });

      it("writes on a hidden link return absent and change nothing", async () => {
        const { gone } = await twoLinks();
        const at = new Date("2026-03-01T00:00:00Z");
        const later = new Date("2026-04-01T00:00:00Z");
        await h.store.unmarkDeleted(A, gone, EPOCH);
        await h.store.claimSurfaced(A, [gone], { at, notSurfacedAfter: at, now: at });
        const before = await h.store.get(A, gone);
        await h.store.markDeleted(A, gone, clock);

        expect(await h.store.update(A, gone, { title: "x", tags: [] })).toBeNull();
        expect(await h.store.updateIf(A, gone, {}, { title: "x" })).toBeNull();
        expect(await h.store.fillWhyIfMissing(A, gone, { text: "w", source: "stated" })).toBeNull();
        expect(
          await h.store.claimSurfaced(A, [gone], {
            at: later,
            notSurfacedAfter: later,
            now: later,
          }),
        ).toEqual([]);
        expect(await h.store.unclaimSurfaced(A, gone, { at, previous: null })).toBe(false);

        await h.store.unmarkDeleted(A, gone, EPOCH);
        expect(await h.store.get(A, gone)).toEqual(before);
      });

      it("saving a hidden link's address makes a new link", async () => {
        const { gone } = await twoLinks();
        const again = await saveLink(deps(), A, { url: "https://ex.com/gone", savedBy: "t" });
        expect(again.created).toBe(true);
        expect(again.link.id).not.toBe(gone);
        const sameKey = async () =>
          (await h.store.listLinks(A)).filter((l) => l.urlKey === again.link.urlKey);
        expect((await sameKey()).map((l) => l.id)).toEqual([again.link.id]);
        await h.store.unmarkDeleted(A, gone, EPOCH);
        expect((await sameKey()).map((l) => l.id)).toEqual([again.link.id]);
      });

      it("getLink and updateLink answer not_found for a hidden link", async () => {
        const { gone } = await twoLinks();
        expect(await code(getLink(deps(), A, gone))).toBe("not_found");
        expect(await code(updateLink(deps(), A, gone, { title: "x" }))).toBe("not_found");
      });

      const t = (ms: number) => new Date(clock.getTime() + ms);
      const save = async (owner: string, url: string) =>
        (await saveLink(deps(), owner, { url, savedBy: "t" })).link.id;

      it("markDeleted hides a live link once; a second call, a foreign id and a never-issued id are false", async () => {
        const id = await save(A, "https://ex.com/1");
        expect(await h.store.markDeleted(B, id, t(0))).toBe(false);
        expect(await h.store.get(A, id)).not.toBeNull();
        expect(await h.store.markDeleted(A, id, t(0))).toBe(true);
        expect(await h.store.get(A, id)).toBeNull();
        expect(await h.store.markDeleted(A, id, t(1))).toBe(false);
        for (const never of ["", "nope", "999999", "-1"]) {
          expect(await h.store.markDeleted(A, never, t(0))).toBe(false);
        }
        // The second call left the deletion time alone, so a restore from t(0) still works.
        expect(await h.store.unmarkDeleted(A, id, t(0))).toBe(true);
      });

      it("unmarkDeleted inside the window brings the link back exactly as it was", async () => {
        const { link } = await saveLink(deps(), A, {
          url: "https://ex.com/1",
          savedBy: "t",
          why: { text: "for the trip", source: "stated" },
          tags: [{ name: "travel", source: "stated" }],
        });
        await updateLink(deps(), A, link.id, { state: "archived" });
        const before = await h.store.get(A, link.id);
        expect(before).toMatchObject({ state: "archived", why: { text: "for the trip" } });
        expect(before?.tags.map((x) => x.key)).toEqual(["travel"]);
        expect(await h.store.markDeleted(A, link.id, t(10))).toBe(true);
        expect(await h.store.unmarkDeleted(A, link.id, t(5))).toBe(true);
        expect(await h.store.get(A, link.id)).toEqual(before);
        expect((await h.store.listLinks(A)).map((l) => l.id)).toEqual([link.id]);
      });

      it("unmarkDeleted before 'since' or after a purge is false and changes nothing", async () => {
        const id = await save(A, "https://ex.com/1");
        expect(await h.store.unmarkDeleted(A, id, EPOCH)).toBe(false);
        expect(await h.store.get(A, id)).not.toBeNull();
        await h.store.markDeleted(A, id, t(10));
        expect(await h.store.unmarkDeleted(A, id, t(11))).toBe(false);
        expect(await h.store.unmarkDeleted(B, id, EPOCH)).toBe(false);
        expect(await h.store.get(A, id)).toBeNull();
        expect(await h.store.purgeDeleted(t(11))).toBe(1);
        expect(await h.store.unmarkDeleted(A, id, EPOCH)).toBe(false);
        expect(await h.store.get(A, id)).toBeNull();
        expect(await h.store.listLinks(A)).toEqual([]);
      });

      it("purgeDeleted removes only links hidden before the cutoff, for every owner, and leaves live ones", async () => {
        const a1 = await save(A, "https://ex.com/1");
        const a2 = await save(A, "https://ex.com/2");
        const live = await save(A, "https://ex.com/3");
        const b1 = await save(B, "https://ex.com/1");
        await h.store.markDeleted(A, a1, t(0));
        await h.store.markDeleted(A, a2, t(100));
        await h.store.markDeleted(B, b1, t(0));
        expect(await h.store.purgeDeleted(t(50))).toBe(2);
        expect(await h.store.purgeDeleted(t(50))).toBe(0);
        expect(await h.store.unmarkDeleted(A, a1, EPOCH)).toBe(false);
        expect(await h.store.unmarkDeleted(B, b1, EPOCH)).toBe(false);
        expect(await h.store.unmarkDeleted(A, a2, EPOCH)).toBe(true);
        expect((await h.store.listLinks(A)).map((l) => l.id).sort()).toEqual([a2, live].sort());
        expect(await h.store.listLinks(B)).toEqual([]);
      });

      it("never issues a purged link's id again", async () => {
        const earlier = [
          await save(A, "https://ex.com/1"),
          await save(A, "https://ex.com/2"),
          await save(A, "https://ex.com/3"),
        ];
        await h.store.markDeleted(A, earlier[2] as string, t(0));
        expect(await h.store.purgeDeleted(t(1))).toBe(1);
        const next = await save(A, "https://ex.com/4");
        expect(earlier).not.toContain(next);
      });

      it("a restore after a re-save of the same address is false", async () => {
        const old = await save(A, "https://ex.com/1");
        await h.store.markDeleted(A, old, t(0));
        const fresh = await save(A, "https://ex.com/1");
        expect(fresh).not.toBe(old);
        expect(await h.store.unmarkDeleted(A, old, EPOCH)).toBe(false);
        expect((await h.store.listLinks(A)).map((l) => l.id)).toEqual([fresh]);
        expect(await h.store.get(A, old)).toBeNull();
      });
    });
  });
}
