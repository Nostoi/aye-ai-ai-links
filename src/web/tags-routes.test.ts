import { describe, expect, it, vi } from "vitest";
import { AUTH_BODY_LIMIT } from "../auth/http.js";
import { addSecondUser, oauthWorld, SECOND_USER, type World } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import type { NameVectors } from "../core/tag-suggest.js";
import type { Tag } from "../core/types.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const B = SECOND_USER.id;

type Seed = Partial<Omit<Tag, "key">> & { key: string };

/** Puts a tag in an owner's catalog, as the store keeps it. */
function seed(world: World, owner: string, t: Seed) {
  world.links
    .prepare(
      `INSERT INTO tags (owner_id, key, name, kind, kind_source, color, pinned, project_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      owner,
      t.key,
      t.name ?? t.key,
      t.kind ?? "topic",
      t.kindSource ?? "stated",
      t.color ?? null,
      t.pinned ? 1 : 0,
      t.projectStatus ?? null,
    );
}

/** Every tag row of every owner, so a refusal can be shown to have changed none. */
const tagRows = (world: World) =>
  world.links.prepare("SELECT * FROM tags ORDER BY owner_id, key").all();
const rowOf = (world: World, owner: string, key: string) =>
  world.links
    .prepare(
      "SELECT kind, kind_source AS kindSource, color, pinned, project_status AS projectStatus FROM tags WHERE owner_id = ? AND key = ?",
    )
    .get(owner, key);

async function signedIn(world: World) {
  const browser = world.agent();
  await browser.signIn();
  return browser;
}

const posting = (json: unknown) => ({ method: "POST", json });
const AGENT_WORDS = /update_tag|search_links|save_link/;

describe("the Tags page", () => {
  it("sends a browser without a session to /login", async () => {
    const res = await (await oauthWorld()).agent().send("/tags");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("lists the owner's tags only, escaped and uncached", async () => {
    const world = await oauthWorld();
    await addSecondUser(world);
    seed(world, "owner", {
      key: "<img src=x onerror=alert(1)>",
      name: "<img src=x onerror=alert(1)>",
    });
    seed(world, "owner", { key: "kitchen", name: "Kitchen", color: "clay", pinned: true });
    seed(world, B, { key: "b-only", name: "B's secret tag" });
    const res = await (await signedIn(world)).send("/tags");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = String(res.body);
    expect(html).toContain("Kitchen");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("B's secret tag");
  });

  it("is linked from the menu", async () => {
    const world = await oauthWorld();
    const html = String((await (await signedIn(world)).send("/")).body);
    expect(html).toContain('<a class="menu-page" href="/tags">Spaces and tags</a>');
  });

  it("refuses GET /tags with a foreign Origin, and serves it without one", async () => {
    const browser = await signedIn(await oauthWorld());
    expect(
      (await browser.send("/tags", { headers: { origin: "https://evil.example" } })).status,
    ).toBe(403);
    expect((await browser.send("/tags")).status).toBe(200);
  });
});

describe("tag actions from the Tags page", () => {
  it("pins a tag: 200 uncached with the tag, which has the free color; unpinning keeps it", async () => {
    const world = await oauthWorld();
    seed(world, "owner", { key: "baking", color: "teal" });
    seed(world, "owner", { key: "kitchen", name: "Kitchen" });
    const browser = await signedIn(world);
    const res = await browser.send("/tags/pin", posting({ key: "kitchen", pinned: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toEqual({
      tag: expect.objectContaining({
        key: "kitchen",
        name: "Kitchen",
        pinned: true,
        color: "clay",
      }),
    });
    const off = await browser.send("/tags/pin", posting({ key: "kitchen", pinned: false }));
    expect(off.body).toEqual({ tag: expect.objectContaining({ pinned: false, color: "clay" }) });
    expect(rowOf(world, "owner", "kitchen")).toMatchObject({ pinned: 0, color: "clay" });
  });

  it("sets a color, and refuses one that is not a space color in the owner's words", async () => {
    const world = await oauthWorld();
    seed(world, "owner", { key: "kitchen", color: "clay", pinned: true });
    const browser = await signedIn(world);
    const res = await browser.send("/tags/color", posting({ key: "kitchen", color: "violet" }));
    expect(res.status).toBe(200);
    expect(rowOf(world, "owner", "kitchen")).toMatchObject({ color: "violet" });
    const before = tagRows(world);
    const amber = await browser.send("/tags/color", posting({ key: "kitchen", color: "amber" }));
    expect(amber.status).toBe(400);
    expect(amber.body).toEqual({ code: "invalid_input", message: "Pick one of the six colors." });
    expect(tagRows(world)).toEqual(before);
  });

  it("confirms a guessed kind, or changes it, and answers in the owner's words", async () => {
    const world = await oauthWorld();
    seed(world, "owner", {
      key: "kitchen",
      kind: "project",
      kindSource: "inferred",
      projectStatus: "done",
    });
    const browser = await signedIn(world);
    const confirmed = await browser.send(
      "/tags/kind",
      posting({ key: "kitchen", kind: "project" }),
    );
    expect(confirmed.status).toBe(200);
    expect(rowOf(world, "owner", "kitchen")).toMatchObject({
      kind: "project",
      kindSource: "stated",
      projectStatus: "done",
    });
    const topic = await browser.send("/tags/kind", posting({ key: "kitchen", kind: "topic" }));
    expect(topic.body).toEqual({
      tag: expect.objectContaining({ kind: "topic", projectStatus: null }),
    });
    const bad = await browser.send("/tags/kind", posting({ key: "kitchen", kind: "folder" }));
    expect(bad.status).toBe(400);
    expect(String(bad.bytes)).not.toMatch(AGENT_WORDS);
  });

  it("marks a project done and reopens it, and refuses a topic, writing nothing", async () => {
    const world = await oauthWorld();
    seed(world, "owner", { key: "kitchen", kind: "project", projectStatus: "active" });
    seed(world, "owner", { key: "baking" });
    const browser = await signedIn(world);
    const done = await browser.send("/tags/status", posting({ key: "kitchen", status: "done" }));
    expect(done.status).toBe(200);
    expect(rowOf(world, "owner", "kitchen")).toMatchObject({ projectStatus: "done" });
    await browser.send("/tags/status", posting({ key: "kitchen", status: "active" }));
    expect(rowOf(world, "owner", "kitchen")).toMatchObject({ projectStatus: "active" });
    const before = tagRows(world);
    const topic = await browser.send("/tags/status", posting({ key: "baking", status: "done" }));
    expect(topic.status).toBe(400);
    expect(topic.body).toEqual({
      code: "invalid_input",
      message: "Only a project can be done or reopened. Make it a project first.",
    });
    expect(tagRows(world)).toEqual(before);
  });

  it.each([
    ["/tags/pin", { pinned: true }],
    ["/tags/color", { color: "teal" }],
    ["/tags/kind", { kind: "project" }],
    ["/tags/status", { status: "done" }],
  ])("answers 404 in the owner's words for a tag that is not there: %s", async (path, rest) => {
    const world = await oauthWorld();
    const res = await (await signedIn(world)).send(path, posting({ key: "nope", ...rest }));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      code: "not_found",
      message: "That tag is not there any more. Reload the page.",
    });
  });

  it("acts for the signed-in user: a second user's actions change only their own tag with the same name", async () => {
    const world = await oauthWorld();
    const bBrowser = await addSecondUser(world);
    seed(world, "owner", {
      key: "kitchen",
      name: "Kitchen",
      kind: "project",
      kindSource: "inferred",
      color: "clay",
      pinned: true,
      projectStatus: "active",
    });
    seed(world, "owner", { key: "a-only", name: "A's private tag", kind: "project" });
    seed(world, B, {
      key: "kitchen",
      name: "kitchen",
      kind: "project",
      kindSource: "inferred",
      projectStatus: "active",
    });
    const ownerRows = () =>
      world.links.prepare("SELECT * FROM tags WHERE owner_id = 'owner' ORDER BY key").all();
    const before = ownerRows();

    const listed = String((await bBrowser.send("/tags")).body);
    const answers = [
      await bBrowser.send("/tags/pin", posting({ key: "kitchen", pinned: true })),
      await bBrowser.send("/tags/color", posting({ key: "kitchen", color: "rose" })),
      await bBrowser.send("/tags/status", posting({ key: "kitchen", status: "done" })),
      await bBrowser.send("/tags/kind", posting({ key: "kitchen", kind: "project" })),
    ];
    const theirs = [
      await bBrowser.send("/tags/pin", posting({ key: "a-only", pinned: true })),
      await bBrowser.send("/tags/color", posting({ key: "a-only", color: "rose" })),
      await bBrowser.send("/tags/status", posting({ key: "a-only", status: "done" })),
      await bBrowser.send("/tags/kind", posting({ key: "a-only", kind: "topic" })),
    ];
    const none = await bBrowser.send("/tags/pin", posting({ key: "never", pinned: true }));

    expect(listed).not.toContain("Kitchen");
    expect(listed).not.toContain("A's private tag");
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200]);
    for (const res of theirs) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(none.body);
    }
    expect(ownerRows()).toEqual(before);
    expect(rowOf(world, B, "kitchen")).toEqual({
      kind: "project",
      kindSource: "stated",
      color: "rose",
      pinned: 1,
      projectStatus: "done",
    });
  });

  const OVER = "x".repeat(AUTH_BODY_LIMIT);
  describe.each([
    ["/tags/pin", { key: "kitchen", pinned: true }, "pinned", "yes"],
    ["/tags/color", { key: "kitchen", color: "teal" }, "color", 3],
    ["/tags/kind", { key: "kitchen", kind: "project" }, "kind", true],
    ["/tags/status", { key: "kitchen", status: "done" }, "status", 1],
  ] as const)("POST %s", (path, body, field, wrong) => {
    async function tagsWorld() {
      const world = await oauthWorld();
      seed(world, "owner", {
        key: "kitchen",
        kind: "project",
        kindSource: "inferred",
        projectStatus: "active",
      });
      return world;
    }

    const refusals: [string, () => object, number][] = [
      ["without an Origin", () => ({ json: body, origin: false }), 403],
      [
        "with a foreign Origin",
        () => ({ json: body, headers: { origin: "https://evil.example" } }),
        403,
      ],
      ["with a foreign Host", () => ({ json: body, headers: { host: "evil.example" } }), 403],
      ["without a session", () => ({ json: body, anonymous: true }), 302],
      ["with a body over the cap", () => ({ json: { ...body, pad: OVER } }), 413],
      [
        "with a body over the cap, before reading any session",
        () => ({ json: { ...body, pad: OVER }, anonymous: true }),
        413,
      ],
      ["with a body that is not JSON", () => ({ rawForm: "key=kitchen" }), 400],
      ["without the key", () => ({ json: { ...body, key: undefined } }), 400],
      ["with the key as a number", () => ({ json: { ...body, key: 7 } }), 400],
      [`without its ${field}`, () => ({ json: { key: "kitchen" } }), 400],
      [`with the ${field} of the wrong type`, () => ({ json: { ...body, [field]: wrong } }), 400],
    ];

    it.each(refusals)("refuses a request %s, and every tag row stays", async (_, how, status) => {
      const world = await tagsWorld();
      const before = tagRows(world);
      const { anonymous, ...options } = how() as { anonymous?: true };
      const browser = anonymous ? world.agent() : await signedIn(world);
      const res = await browser.send(path, { method: "POST", ...options });
      expect(res.status).toBe(status);
      expect(tagRows(world)).toEqual(before);
    });

    it("succeeds with the same body from a signed-in page, so each refusal is down to what it changed", async () => {
      const world = await tagsWorld();
      const before = tagRows(world);
      const res = await (await signedIn(world)).send(path, posting(body));
      expect(res.status).toBe(200);
      expect(tagRows(world)).not.toEqual(before);
    });
  });
});

describe("rename, merge, delete and undo from the Tags page", () => {
  let clock = 1_000;
  const depsOf = (world: World) => ({
    ...createDeps(world.links, new FakeEmbedder(DIMS)),
    now: () => new Date(clock++),
  });
  const save = (world: World, owner: string, url: string, tags: string[]) =>
    saveLink(depsOf(world), owner, {
      url,
      title: url,
      savedBy: "seed",
      tags: tags.map((name) => ({ name, source: "stated" as const })),
    });
  /** Every tag, link-tag, alias and receipt row of every owner, so a refusal can be shown to have changed none. */
  const everything = (world: World) => ({
    tags: tagRows(world),
    linkTags: world.links
      .prepare("SELECT * FROM link_tags ORDER BY owner_id, link_id, tag_id")
      .all(),
    aliases: world.links.prepare("SELECT * FROM tag_aliases ORDER BY owner_id, old_key").all(),
    changes: world.links.prepare("SELECT * FROM tag_changes ORDER BY owner_id, change_id").all(),
  });
  const aRows = (world: World) =>
    world.links
      .prepare(
        `SELECT t.key, lt.link_id, lt.source, lt.position FROM tags t
         LEFT JOIN link_tags lt ON lt.tag_id = t.id
         WHERE t.owner_id = 'owner' ORDER BY t.key, lt.link_id`,
      )
      .all();

  async function twoOwners() {
    const world = await oauthWorld();
    const bBrowser = await addSecondUser(world);
    await save(world, "owner", "https://a.example/1", ["art"]);
    await save(world, "owner", "https://a.example/2", ["art", "design"]);
    await save(world, "owner", "https://a.example/3", ["design"]);
    await save(world, B, "https://b.example/1", ["art"]);
    return { world, bBrowser, browser: await signedIn(world) };
  }

  it("rename answers the tag and writes it", async () => {
    const { world, browser } = await twoOwners();
    const res = await browser.send("/tags/rename", posting({ key: "art", name: "Art Work" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toEqual({
      tag: expect.objectContaining({ key: "art work", name: "Art Work" }),
    });
    expect(rowOf(world, "owner", "art work")).toBeDefined();
    expect(rowOf(world, "owner", "art")).toBeUndefined();
  });

  it("rename onto an existing name is 409 taken and nothing changes", async () => {
    const { world, browser } = await twoOwners();
    const before = everything(world);
    const res = await browser.send("/tags/rename", posting({ key: "art", name: "Design" }));
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toEqual({
      code: "taken",
      tag: expect.objectContaining({ key: "design" }),
      links: 2,
      message: expect.any(String),
    });
    expect(everything(world)).toEqual(before);
  });

  it("merge answers the kept tag's resulting count", async () => {
    const { world, browser } = await twoOwners();
    const res = await browser.send("/tags/merge", posting({ key: "art", into: "design" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toEqual({
      tag: expect.objectContaining({ key: "design" }),
      changeId: expect.any(String),
      moved: 2,
      links: 3,
    });
    expect(rowOf(world, "owner", "art")).toBeUndefined();
  });

  it("delete answers how many links lost the tag, and leaves B's tag", async () => {
    const { world, browser } = await twoOwners();
    const res = await browser.send("/tags/delete", posting({ key: "art" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ changeId: expect.any(String), moved: 2 });
    expect(rowOf(world, "owner", "art")).toBeUndefined();
    expect(rowOf(world, B, "art")).toBeDefined();
  });

  it("undo after a merge puts both rows back", async () => {
    const { world, browser } = await twoOwners();
    const before = aRows(world);
    const merged = (await browser.send("/tags/merge", posting({ key: "art", into: "design" })))
      .body as { changeId: string };
    expect(aRows(world)).not.toEqual(before);
    const res = await browser.send("/tags/undo", posting({ changeId: merged.changeId }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toEqual({
      tags: expect.arrayContaining([
        { tag: expect.objectContaining({ key: "art" }), links: 2 },
        { tag: expect.objectContaining({ key: "design" }), links: 2 },
      ]),
    });
    expect(aRows(world)).toEqual(before);
  });

  it("undo after a delete puts the tag back", async () => {
    const { world, browser } = await twoOwners();
    const before = aRows(world);
    const gone = (await browser.send("/tags/delete", posting({ key: "art" }))).body as {
      changeId: string;
    };
    expect((await browser.send("/tags/undo", posting({ changeId: gone.changeId }))).status).toBe(
      200,
    );
    expect(aRows(world)).toEqual(before);
  });

  it("answers 404, 400 and a too-late undo in the owner's words, writing nothing", async () => {
    const { world, browser } = await twoOwners();
    const before = everything(world);
    const missing = await browser.send("/tags/merge", posting({ key: "nope", into: "design" }));
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      code: "not_found",
      message: "That tag is not there any more. Reload the page.",
    });
    const same = await browser.send("/tags/merge", posting({ key: "art", into: "art" }));
    expect(same.status).toBe(400);
    expect(String(same.bytes)).not.toMatch(AGENT_WORDS);
    const late = await browser.send("/tags/undo", posting({ changeId: "no-such-change" }));
    expect(late.status).toBe(404);
    expect(late.body).toEqual({
      code: "not_found",
      message: "It's too late to undo: that change was already undone, or can no longer be undone.",
    });
    expect(everything(world)).toEqual(before);
  });

  it("undo is 409 with core's words and writes nothing once the tags moved", async () => {
    const { world, browser } = await twoOwners();
    const merged = (await browser.send("/tags/merge", posting({ key: "art", into: "design" })))
      .body as { changeId: string };
    await save(world, "owner", "https://a.example/4", ["art"]);
    const before = everything(world);
    const res = await browser.send("/tags/undo", posting({ changeId: merged.changeId }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "conflict",
      message: "The tags changed since, so nothing was undone.",
    });
    expect(everything(world)).toEqual(before);
  });

  it("acts for the signed-in user: B's requests for A's tags are 404 and every row stays", async () => {
    const { world, bBrowser, browser } = await twoOwners();
    const merged = (await browser.send("/tags/merge", posting({ key: "art", into: "design" })))
      .body as { changeId: string };
    await save(world, B, "https://b.example/2", ["b-only"]);
    const before = everything(world);
    const none = await bBrowser.send("/tags/delete", posting({ key: "never" }));
    const attempts = [
      await bBrowser.send("/tags/rename", posting({ key: "design", name: "ui design" })),
      await bBrowser.send("/tags/merge", posting({ key: "design", into: "b-only" })),
      await bBrowser.send("/tags/merge", posting({ key: "b-only", into: "design" })),
      await bBrowser.send("/tags/delete", posting({ key: "design" })),
    ];
    for (const res of attempts) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(none.body);
    }
    const undo = await bBrowser.send("/tags/undo", posting({ changeId: merged.changeId }));
    expect(undo.status).toBe(404);
    expect(everything(world)).toEqual(before);
  });

  describe("suggested merges", () => {
    /** Every name its own direction, so only spelling twins are suggested. */
    const apartNames = (): NameVectors => {
      const seen = new Map<string, number>();
      return {
        async vectorOf(name) {
          const i = seen.get(name) ?? seen.size;
          seen.set(name, i);
          const v = new Float32Array(32);
          v[i] = 1;
          return v;
        },
      };
    };
    const SECTION = "Tags you might combine";
    const dismissals = (world: World) =>
      world.links
        .prepare("SELECT owner_id AS o, key_a AS a, key_b AS b FROM tag_merge_dismissals")
        .all();

    async function twinWorld(extra: { names?: NameVectors; tagSuggestWaitMs?: number } = {}) {
      const world = await oauthWorld({ names: apartNames(), ...extra });
      const bBrowser = await addSecondUser(world);
      await save(world, "owner", "https://a.example/1", ["pixel art"]);
      await save(world, "owner", "https://a.example/2", ["pixel-art"]);
      await save(world, B, "https://b.example/1", ["pixel art"]);
      await save(world, B, "https://b.example/2", ["pixel-art"]);
      return { world, bBrowser, browser: await signedIn(world) };
    }

    it("shows the section above the list when the owner has a suggestion", async () => {
      const { browser } = await twinWorld();
      const html = String((await browser.send("/tags")).body);
      expect(html).toContain(SECTION);
      expect(html).toContain("Keep pixel-art");
      expect(html).toContain("Keep pixel art");
      expect(html.indexOf(SECTION)).toBeLessThan(html.indexOf('id="tags"'));
    });

    it("shows no section when there is no suggestion", async () => {
      const world = await oauthWorld({ names: apartNames() });
      await save(world, "owner", "https://a.example/1", ["art"]);
      const html = String((await (await signedIn(world)).send("/tags")).body);
      expect(html).not.toContain(SECTION);
    });

    it("renders the page without the section when the names never embed, within the wait", async () => {
      const never: NameVectors = { vectorOf: () => new Promise<Float32Array>(() => {}) };
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { browser } = await twinWorld({ names: never, tagSuggestWaitMs: 20 });
        const res = await browser.send("/tags");
        expect(res.status).toBe(200);
        const html = String(res.body);
        expect(html).not.toContain(SECTION);
        expect(html).toContain("pixel art");
        expect(errors).toHaveBeenCalledTimes(1);
        expect(String(errors.mock.calls[0]?.[0])).toMatch(/^\[tags\] suggestions skipped: /);
      } finally {
        errors.mockRestore();
      }
    });

    it("renders the page without the section when embedding fails", async () => {
      const broken: NameVectors = {
        vectorOf: () => Promise.reject(new Error("model not loaded")),
      };
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { browser } = await twinWorld({ names: broken });
        const res = await browser.send("/tags");
        expect(res.status).toBe(200);
        expect(String(res.body)).not.toContain(SECTION);
        expect(String(errors.mock.calls[0]?.[0])).toContain("model not loaded");
      } finally {
        errors.mockRestore();
      }
    });

    it("dismiss records the pair for the signed-in owner, answers 204, and undismiss removes it", async () => {
      const { world, browser } = await twinWorld();
      const gone = await browser.send(
        "/tags/suggestions/dismiss",
        posting({ a: "pixel-art", b: "pixel art" }),
      );
      expect(gone.status).toBe(204);
      expect(gone.headers.get("cache-control")).toBe("no-store");
      expect(dismissals(world)).toEqual([{ o: "owner", a: "pixel art", b: "pixel-art" }]);
      expect(String((await browser.send("/tags")).body)).not.toContain(SECTION);
      const back = await browser.send(
        "/tags/suggestions/undismiss",
        posting({ a: "pixel art", b: "pixel-art" }),
      );
      expect(back.status).toBe(204);
      expect(dismissals(world)).toEqual([]);
      expect(String((await browser.send("/tags")).body)).toContain(SECTION);
    });

    it("B's dismissal and undismissal of the same keys leave A's suggestion and dismissal alone", async () => {
      const { world, bBrowser, browser } = await twinWorld();
      const body = posting({ a: "pixel art", b: "pixel-art" });
      expect((await bBrowser.send("/tags/suggestions/dismiss", body)).status).toBe(204);
      expect(dismissals(world)).toEqual([{ o: B, a: "pixel art", b: "pixel-art" }]);
      expect(String((await browser.send("/tags")).body)).toContain(SECTION);
      await browser.send("/tags/suggestions/dismiss", body);
      expect(dismissals(world)).toHaveLength(2);
      await bBrowser.send("/tags/suggestions/undismiss", body);
      expect(dismissals(world)).toEqual([{ o: "owner", a: "pixel art", b: "pixel-art" }]);
      expect(String((await browser.send("/tags")).body)).not.toContain(SECTION);
    });

    describe.each(["/tags/suggestions/dismiss", "/tags/suggestions/undismiss"])(
      "POST %s",
      (path) => {
        const body = { a: "pixel art", b: "pixel-art" };
        const refusals: [string, () => object, number][] = [
          ["without an Origin", () => ({ json: body, origin: false }), 403],
          [
            "with a foreign Origin",
            () => ({ json: body, headers: { origin: "https://evil.example" } }),
            403,
          ],
          ["without a session", () => ({ json: body, anonymous: true }), 302],
          ["with a body that is not JSON", () => ({ rawForm: "a=x" }), 400],
          ["with a number for a key", () => ({ json: { ...body, a: 7 } }), 400],
          ["without the second key", () => ({ json: { a: "x" } }), 400],
          ["with a blank key", () => ({ json: { a: " ", b: "x" } }), 400],
        ];
        it.each(refusals)("refuses a request %s, and records nothing", async (_, how, status) => {
          const { world } = await twinWorld();
          const { anonymous, ...options } = how() as { anonymous?: true };
          const browser = anonymous ? world.agent() : await signedIn(world);
          const res = await browser.send(path, { method: "POST", ...options });
          expect(res.status).toBe(status);
          expect(dismissals(world)).toEqual([]);
        });
      },
    );
  });

  describe.each([
    ["/tags/rename", { key: "art", name: "Art Work" }],
    ["/tags/merge", { key: "art", into: "design" }],
    ["/tags/delete", { key: "art" }],
  ] as const)("POST %s", (path, body) => {
    const refusals: [string, () => object, number][] = [
      ["without an Origin", () => ({ json: body, origin: false }), 403],
      [
        "with a foreign Origin",
        () => ({ json: body, headers: { origin: "https://evil.example" } }),
        403,
      ],
      ["without a session", () => ({ json: body, anonymous: true }), 302],
      ["with a body that is not JSON", () => ({ rawForm: "key=art" }), 400],
      ["with the key as a number", () => ({ json: { ...body, key: 7 } }), 400],
      ["without the key", () => ({ json: { ...body, key: undefined } }), 400],
    ];
    it.each(refusals)("refuses a request %s, and nothing changes", async (_, how, status) => {
      const world = await oauthWorld();
      seed(world, "owner", { key: "art" });
      seed(world, "owner", { key: "design" });
      const before = everything(world);
      const { anonymous, ...options } = how() as { anonymous?: true };
      const browser = anonymous ? world.agent() : await signedIn(world);
      const res = await browser.send(path, { method: "POST", ...options });
      expect(res.status).toBe(status);
      expect(everything(world)).toEqual(before);
    });
  });

  it("refuses an undo with a foreign Origin or no changeId", async () => {
    const world = await oauthWorld();
    seed(world, "owner", { key: "art" });
    seed(world, "owner", { key: "design" });
    const before = everything(world);
    const browser = await signedIn(world);
    const foreign = await browser.send("/tags/undo", {
      method: "POST",
      json: { changeId: "x" },
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    expect((await browser.send("/tags/undo", posting({}))).status).toBe(400);
    expect(everything(world)).toEqual(before);
  });
});
