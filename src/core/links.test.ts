import { beforeEach, describe, expect, it } from "vitest";
import type { CoreError } from "./errors.js";
import { FakeStore } from "./fake-store.js";
import { getLink, saveLink, updateLink } from "./links.js";
import type { Labelled } from "./types.js";

let store: FakeStore;
let clock: Date;
const deps = () => ({ store, now: () => clock });
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

beforeEach(() => {
  store = new FakeStore();
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
    expect(store.all(A)).toHaveLength(1);
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
    const [stored] = store.all(A);
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
    expect(store.all(A)[0]?.why).toEqual(why);
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
    expect(store.all(A)).toHaveLength(0);
  });

  it("rejects a blank tag without touching the store", async () => {
    const p = saveLink(deps(), A, {
      url: "https://ex.com/a",
      savedBy: "agent",
      tags: [{ name: " ", source: "stated" }],
    });
    expect(await code(p)).toBe("invalid_input");
    expect(store.all(A)).toHaveLength(0);
  });
});

describe("saveLink conditional why", () => {
  it("does not overwrite a why set concurrently between insert and fill", async () => {
    class RacingStore extends FakeStore {
      override async insertIfAbsent(...args: Parameters<FakeStore["insertIfAbsent"]>) {
        const result = await super.insertIfAbsent(...args);
        if (!result.created) {
          await this.update(args[0], result.link.id, {
            why: { text: "concurrent", source: "stated" },
          });
        }
        return result;
      }
    }
    store = new RacingStore();
    await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
    await saveLink(deps(), A, {
      url: "https://ex.com/a",
      savedBy: "agent",
      why: { text: "mine", source: "asked" },
    });
    expect(store.all(A)[0]?.why).toEqual({ text: "concurrent", source: "stated" });
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
    expect(store.all(A)).toHaveLength(0);
  });

  it("updateLink rejects a bad state, why source or tag source and changes nothing", async () => {
    const { link } = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
    const before = structuredClone(store.all(A));
    const patches = [
      { state: bogus },
      { why: { text: "w", source: bogus } },
      { tags: [{ name: "t", source: bogus }] },
    ];
    for (const patch of patches) {
      expect(await code(updateLink(deps(), A, link.id, patch))).toBe("invalid_input");
    }
    expect(store.all(A)).toEqual(before);
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
    const updated = await updateLink(deps(), A, link.id, { summary: "s", ...forbidden } as never);
    expect(updated.summary).toBe("s");
    expect(store.all(A)).toEqual([{ ...link, summary: "s" }]);
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
    expect(store.all(A)[0]?.tags).toEqual(updated.tags);
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
    const set = await updateLink(deps(), A, link.id, { why: { text: "  w  ", source: "asked" } });
    expect(set.why).toEqual({ text: "w", source: "asked" });
    const cleared = await updateLink(deps(), A, link.id, { why: { text: " ", source: "stated" } });
    expect(cleared.why).toBeNull();
    expect(store.all(A)[0]?.why).toBeNull();
  });

  it("applies state, snoozedUntil and lastOpenedAt", async () => {
    const { link } = await saveLink(deps(), A, { url: "https://ex.com/a", savedBy: "agent" });
    const snooze = new Date("2026-03-01T00:00:00Z");
    const updated = await updateLink(deps(), A, link.id, {
      state: "archived",
      snoozedUntil: snooze,
      lastOpenedAt: clock,
    });
    expect(updated).toMatchObject({ state: "archived", snoozedUntil: snooze, lastOpenedAt: clock });
  });

  it("throws not_found for another owner and leaves the link unchanged", async () => {
    const { link } = await saveLink(deps(), A, {
      url: "https://ex.com/a",
      savedBy: "agent",
      summary: "orig",
    });
    const before = structuredClone(store.all(A));
    const p = updateLink(deps(), B, link.id, { summary: "hacked", state: "archived" });
    expect(await code(p)).toBe("not_found");
    expect(store.all(A)).toEqual(before);
  });
});
