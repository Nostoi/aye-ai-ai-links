import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentKey } from "../auth/agent-keys.js";
import {
  addSecondUser,
  approve,
  CLAUDE_ID,
  CLAUDE_REDIRECT,
  connectAs,
  connectClaude,
  connectClaudeAs,
  DCR_REDIRECT,
  exchange,
  field,
  oauthWorld,
  pkce,
  refresh,
  SECOND_USER,
  type Sent,
  saveLinkWith,
  type World,
} from "../auth/oauth-test-kit.js";
import { png } from "../core/image-test-kit.js";
import { saveLink, updateLink } from "../core/links.js";
import { addProfile } from "../core/profile.js";
import { copyLimits, imageRef } from "../core/saved-copy.js";
import { setTagPinned } from "../core/tag-space.js";
import { keepHandy } from "../core/tools.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { SqliteImageStore } from "../store/sqlite-image-store.js";
import { outsideRefs } from "../web/outside-refs-test-kit.js";

/**
 * Owner isolation through every door, with real credentials: agent keys, OAuth access tokens and
 * web sessions. Each test shows what B's request did and that A's rows are exactly as they were.
 */

const A = "owner";
const B = SECOND_USER.id;
const A_URL = "https://a.example/secret";
const B_URL = "https://b.example/mine";
const A_KEY_NAME = "agent-a route guard";
const A_TAG_NAME = "Quokka den plans";
const A_TOOL_TITLE = "Quokka keeper login";
const A_DONE_URL = "https://a.example/remote-image";
const A_UNTAGGED_DONE_URL = "https://a.example/done-without-a-tag";

type Called = { status: number; isError: boolean; data: unknown; text: string };
type Row = { id: string };
type SavedLink = { link: Row; created: boolean };
type Found = { links: Row[] };
type Digest = { links: { link: Row; reasons: { kind: string; focus?: { text: string } }[] }[] };
type Profile = { notes: { id: string; text: string }[]; recentFocus: { text: string }[] };
type Tagged = { tag: { name: string; kind: string; kindSource: string } };

let rpcId = 0;
async function call(world: World, token: string, name: string, args: unknown): Promise<Called> {
  const res = await world.app.fetch(
    new Request("https://links.example/mcp", {
      method: "POST",
      headers: {
        host: "links.example",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data:"));
  const result = data ? JSON.parse(data.slice(5)).result : undefined;
  return {
    status: res.status,
    isError: result?.isError === true,
    data: result?.structuredContent,
    text: String(result?.content?.[0]?.text ?? ""),
  };
}

/** A tool call that must succeed. */
async function tool<T>(world: World, token: string, name: string, args: unknown): Promise<T> {
  const res = await call(world, token, name, args);
  expect(res, `${name} should succeed`).toMatchObject({ status: 200, isError: false });
  return res.data as T;
}

/** A tool call the door must refuse with the error `message` names, so a bad argument cannot pass for a refusal. */
async function refused(world: World, token: string, name: string, args: unknown, message: RegExp) {
  const res = await call(world, token, name, args);
  expect(res, `${name} should be refused`).toMatchObject({ status: 200, isError: true });
  expect(res.text).toMatch(message);
}

const NO_LINK = /No link with id/;
const NO_NOTE = /No profile note with id/;

const TOOLS_EXERCISED_ACROSS_TWO_OWNERS = [
  "add_profile",
  "edit_profile",
  "get_digest",
  "get_link",
  "get_profile",
  "list_links",
  "save_link",
  "search_links",
  "update_link",
  "update_tag",
];
const KNOWN_OWNED_TABLES = [
  "focus_log",
  "link_images",
  "link_tags",
  "link_vectors",
  "links",
  "profile_notes",
  "search_log",
  "snapshots",
  "tags",
];
const ownedTablesOf = (world: World): string[] =>
  (
    world.links
      .prepare(
        `SELECT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) c
         WHERE m.type = 'table' AND c.name = 'owner_id' ORDER BY m.name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
const rowsOf = (world: World, owner: string) =>
  Object.fromEntries(
    ownedTablesOf(world).map((t) => [
      t,
      world.links.prepare(`SELECT * FROM "${t}" WHERE owner_id = ? ORDER BY rowid`).all(owner),
    ]),
  );
const grantsOf = (world: World, userId: string) =>
  ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"].map((t) =>
    world.db.prepare(`SELECT * FROM ${t} WHERE userId = ? ORDER BY id`).all(userId),
  );

type Door = { a: string; b: string; savedByB: string };
const doors: Record<string, (world: World) => Promise<Door>> = {
  "agent key": async (world) => ({
    a: createAgentKey(world.keyStore, { owner: A, ownerName: "A", agent: "agent-a" }).key,
    b: createAgentKey(world.keyStore, { owner: B, ownerName: "B", agent: "agent-b" }).key,
    savedByB: "agent-b",
  }),
  "OAuth token": async (world) => ({
    a: (await connectClaude(world)).access,
    b: await connectClaudeAs(world, await addSecondUser(world)),
    savedByB: "Claude",
  }),
};

/** A has a tagged link, a note, a focus entry and a logged search; B has a link with the same tag. */
async function fixture() {
  const world = await oauthWorld();
  return { world, seed: (door: Door) => seed(world, door) };
}
async function seed(world: World, door: Door) {
  const a = await tool<SavedLink>(world, door.a, "save_link", {
    url: A_URL,
    title: "secretword",
    summary: "secretword summary",
    why: { text: "secretword reason", source: "stated" },
    tags: [{ name: "Alpha", source: "stated" }],
  });
  const added = await tool<{ addedNoteIds: string[] }>(world, door.a, "add_profile", {
    addNotes: [{ text: "A private note", source: "stated" }],
    addFocus: [{ text: "secretword", source: "stated" }],
  });
  await tool(world, door.a, "search_links", { query: "secretword" });
  const b = await tool<SavedLink>(world, door.b, "save_link", {
    url: B_URL,
    title: "secretword bravo",
    tags: [{ name: "Alpha", source: "stated" }],
  });
  // Through core, not the door: only a call under test then depends on the owner the door supplies.
  const bNote = await addProfile(createDeps(world.links, new FakeEmbedder(DIMS)), B, "seed-b", {
    addNotes: [{ text: "B private note", source: "stated" }],
  });
  return {
    aId: a.link.id,
    aNoteId: added.addedNoteIds[0] as string,
    bId: b.link.id,
    bNoteId: bNote.addedNoteIds[0] as string,
  };
}

describe.each(Object.keys(doors))("owner isolation through the %s door", (doorName) => {
  const open = async () => {
    const { world } = await fixture();
    const door = await (doors[doorName] as (w: World) => Promise<Door>)(world);
    const ids = await seed(world, door);
    return { world, door, ...ids, snapA: () => rowsOf(world, A) };
  };

  it("T1: stores B's save under B with the door's savedBy, whatever owner and savedBy it sends", async () => {
    const { world, door, snapA } = await open();
    const before = snapA();
    expect(before.links).toHaveLength(1);

    const spoofed = await tool<SavedLink>(world, door.b, "save_link", {
      url: "https://b.example/spoof",
      owner: A,
      savedBy: "evil",
      title: "spoof",
    });

    const row = world.links
      .prepare("SELECT owner_id AS owner, saved_by AS savedBy FROM links WHERE id = ?")
      .get(Number(spoofed.link.id));
    expect(row).toEqual({ owner: B, savedBy: door.savedByB });
    expect(snapA()).toEqual(before);
  });

  it("T2: B cannot read A's link, finds only its own by search and digest, and A's rows stay as they were", async () => {
    const { world, door, aId, bId, snapA } = await open();
    const before = snapA();

    await refused(world, door.b, "get_link", { id: aId }, NO_LINK);
    const byWord = await tool<Found>(world, door.b, "search_links", { query: "secretword" });
    const listing = await tool<Found>(world, door.b, "search_links", { query: "" });
    const digest = await tool<Digest>(world, door.b, "get_digest", {});

    expect(byWord.links.map((l) => l.id)).toEqual([bId]);
    expect(listing.links.map((l) => l.id)).toEqual([bId]);
    expect(digest.links.map((d) => d.link.id)).toEqual([bId]);
    expect(snapA()).toEqual(before);
  });

  it("T3: B's update_link of A's link is refused, whatever it asks to change", async () => {
    const { world, door, aId, bId, snapA } = await open();
    await tool(world, door.a, "update_link", {
      id: aId,
      handy: { action: "keep", source: "stated" },
    });
    const before = snapA();
    const everything = {
      title: "hijack",
      summary: "hijack",
      why: { text: "hijack", source: "stated" },
      tags: [{ name: "Hijack", source: "stated" }],
      state: "archived",
      snoozedUntil: "2099-01-01T00:00:00Z",
      opened: true,
      handy: { action: "not_handy", source: "stated" },
      owner: A,
    };

    await refused(world, door.b, "update_link", { id: aId, ...everything }, NO_LINK);

    expect(snapA()).toEqual(before);
    // The same arguments are valid on B's own link, so the refusal above was about ownership.
    const own = await tool<{ link: { title: string; handy: unknown } }>(
      world,
      door.b,
      "update_link",
      { id: bId, ...everything },
    );
    expect(own.link.title).toBe("hijack");
    expect(own.link.handy).toEqual({ status: "declined", source: "stated", due: false });
  });

  it("T4: B's update_tag changes B's tag and leaves A's tag of the same name alone", async () => {
    const { world, door, snapA } = await open();
    const before = snapA();
    expect(before.tags).toMatchObject([{ key: "alpha", kind: "topic", kind_source: "inferred" }]);

    const changed = await tool<Tagged>(world, door.b, "update_tag", {
      name: "Alpha",
      kind: "project",
    });

    expect(changed.tag).toMatchObject({ name: "Alpha", kind: "project", kindSource: "stated" });
    expect(
      world.links.prepare("SELECT kind, kind_source FROM tags WHERE owner_id = ?").all(B),
    ).toEqual([{ kind: "project", kind_source: "stated" }]);
    expect(snapA()).toEqual(before);
  });

  it("T5: B's profile holds only B's notes, and B cannot add as, edit or remove A's", async () => {
    const { world, door, aNoteId, snapA } = await open();
    const before = snapA();

    const profile = await tool<Profile>(world, door.b, "get_profile", {});
    expect(profile.notes.map((n) => n.text)).toEqual(["B private note"]);
    expect(profile.recentFocus).toEqual([]);

    await tool(world, door.b, "add_profile", {
      addNotes: [{ text: "B second note", source: "stated" }],
      addFocus: [{ text: "bravo", source: "stated" }],
      owner: A,
      writtenBy: "evil",
    });
    await refused(
      world,
      door.b,
      "edit_profile",
      { editNotes: [{ id: aNoteId, text: "hijack", source: "stated" }] },
      NO_NOTE,
    );
    await refused(world, door.b, "edit_profile", { removeNotes: [aNoteId] }, NO_NOTE);

    const mine = world.links
      .prepare(
        "SELECT text, written_by AS writtenBy FROM profile_notes WHERE owner_id = ? ORDER BY id",
      )
      .all(B);
    expect(mine).toEqual([
      { text: "B private note", writtenBy: "seed-b" },
      { text: "B second note", writtenBy: door.savedByB },
    ]);
    expect(snapA()).toEqual(before);
  });

  it("T12: owner, savedBy and writtenBy sent to any tool change nothing about whose data it reaches", async () => {
    const { world, door, aId, bId, aNoteId, bNoteId, snapA } = await open();
    const before = snapA();
    const spoof = { owner: A, savedBy: "evil", writtenBy: "evil" };

    const found = await tool<Found>(world, door.b, "search_links", {
      query: "secretword",
      ...spoof,
    });
    await refused(world, door.b, "get_link", { id: aId, ...spoof }, NO_LINK);
    const own = await tool<{ link: Row }>(world, door.b, "get_link", { id: bId, ...spoof });
    const tagged = await tool<Tagged>(world, door.b, "update_tag", {
      name: "Alpha",
      kind: "project",
      ...spoof,
    });
    await refused(
      world,
      door.b,
      "edit_profile",
      { editNotes: [{ id: aNoteId, text: "hijack", source: "stated" }], ...spoof },
      NO_NOTE,
    );
    await tool(world, door.b, "edit_profile", {
      editNotes: [{ id: bNoteId, text: "B edited", source: "stated" }],
      ...spoof,
    });

    expect(found.links.map((l) => l.id)).toEqual([bId]);
    expect(own.link.id).toBe(bId);
    expect(tagged.tag.kind).toBe("project");
    expect(
      world.links
        .prepare("SELECT text, written_by AS writtenBy FROM profile_notes WHERE owner_id = ?")
        .all(B),
    ).toEqual([{ text: "B edited", writtenBy: door.savedByB }]);
    expect(snapA()).toEqual(before);

    // get_profile and get_digest take no arguments: an extra key is refused, and nothing is marked surfaced.
    const strict = /unrecognized|invalid|validation/i;
    await refused(world, door.b, "get_profile", spoof, strict);
    await refused(world, door.b, "get_digest", spoof, strict);
    expect(snapA()).toEqual(before);
    expect(
      world.links.prepare("SELECT last_surfaced_at FROM links WHERE owner_id = ?").all(B),
    ).toEqual([{ last_surfaced_at: null }]);
  });

  it("T6: A's focus words surface only A's link, and B's digest never uses them", async () => {
    const { world, door, aId, bId, snapA } = await open();
    const before = snapA();

    const digest = await tool<Digest>(world, door.b, "get_digest", {});

    const [mine] = digest.links;
    expect(digest.links).toHaveLength(1);
    expect(mine?.link.id).toBe(bId);
    expect(mine?.reasons.map((r) => r.kind)).not.toContain("focus_words");
    expect(snapA()).toEqual(before);

    const theirs = await tool<Digest>(world, door.a, "get_digest", {});
    expect(theirs.links.map((d) => d.link.id)).toEqual([aId]);
    expect(theirs.links[0]?.reasons.map((r) => r.kind)).toContain("focus_words");
  });

  it("T14: B's list_links lists and counts only B's links, and A's cursor gets B nothing", async () => {
    const { world, door, bId, snapA } = await open();
    await tool(world, door.a, "save_link", { url: "https://a.example/second" });
    type Listed = Found & { total: number; nextCursor: string | null };
    const aPage = await tool<Listed>(world, door.a, "list_links", { limit: 1 });
    expect(aPage.total).toBe(2);
    expect(aPage.nextCursor).toEqual(expect.any(String));
    const before = snapA();

    const listing = await tool<Listed>(world, door.b, "list_links", { owner: A });
    const res = await call(world, door.b, "list_links", { cursor: aPage.nextCursor, limit: 50 });

    expect(listing).toMatchObject({ total: 1, nextCursor: null });
    expect(listing.links.map((l) => l.id)).toEqual([bId]);
    expect(res).toMatchObject({ status: 200, isError: true });
    expect(res.text).toMatch(/not valid/);
    expect(res.data).toBeUndefined();
    expect(res.text).not.toContain(A_URL);
    expect(snapA()).toEqual(before);
  });

  it("T13: B's save_link response holds only B's tags, notes and focus, though A has others", async () => {
    const { world, door, snapA } = await open();
    await tool(world, door.a, "save_link", {
      url: "https://a.example/second",
      tags: [{ name: "Zulu", source: "stated" }],
    });
    const before = snapA();

    const saved = await tool<{
      filingContext: { tags: { name: string }[]; activeProjects: { name: string }[] };
      profile: Profile;
    }>(world, door.b, "save_link", {
      url: "https://b.example/another",
      tags: [{ name: "Bravo", source: "stated" }],
    });

    expect(saved.filingContext.tags.map((t) => t.name).sort()).toEqual(["Alpha", "Bravo"]);
    expect(saved.profile.notes.map((n) => n.text)).toEqual(["B private note"]);
    expect(saved.profile.recentFocus).toEqual([]);
    expect(snapA()).toEqual(before);
  });
});

describe("owner isolation coverage", () => {
  it("the door lists exactly the tools this suite exercises across two owners", async () => {
    const { world } = await fixture();
    const { key: token } = createAgentKey(world.keyStore, {
      owner: A,
      ownerName: "A",
      agent: "agent-a",
    });
    const res = await world.app.fetch(
      new Request("https://links.example/mcp", {
        method: "POST",
        headers: {
          host: "links.example",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} }),
      }),
    );
    const data = (await res.text()).split("\n").find((l) => l.startsWith("data:"));
    const listed = (JSON.parse((data ?? "data:{}").slice(5)).result?.tools ?? []) as {
      name: string;
    }[];
    expect(listed.map((t) => t.name).sort()).toEqual([...TOOLS_EXERCISED_ACROSS_TWO_OWNERS].sort());
  });

  it("the owner_id tables snapshotted for A include every table the suite first knew", async () => {
    const { world } = await fixture();
    expect(ownedTablesOf(world)).toEqual(expect.arrayContaining(KNOWN_OWNED_TABLES));
  });

  const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
  /** Paths served elsewhere and covered by their own suites. */
  const ELSEWHERE = /^\/(api\/auth|\.well-known|mcp)(\/|$)/;
  const webRoutes = (world: World) => world.app.routes.filter((r) => !ELSEWHERE.test(r.path));

  /**
   * A path a request can name: `:id{[0-9]+}` gets a value its pattern accepts, `*` any segment.
   * Any other parameter tries `1` first, so a copy picture's `:n` is picture 1.
   */
  const fillPath = (path: string, linkId: string) =>
    path
      .replace(/:(\w+)(?:\{((?:[^{}]|\{[^}]*\})*)\})?/g, (_, name: string, pattern?: string) => {
        if (pattern === undefined) return linkId;
        const samples = name === "id" ? [linkId, "1", "a"] : ["1", linkId, "a"];
        const fits = samples.find((v) => new RegExp(`^(?:${pattern})$`).test(v));
        if (fits === undefined) throw new Error(`no sample fits the path parameter {${pattern}}`);
        return fits;
      })
      .replaceAll("*", "x");

  /** A's stored image: a PNG header with bytes no other response holds. */
  const A_IMAGE = png(321, 123, Buffer.from("A's own image bytes for the route guard"));
  /** A's saved-copy picture: distinct bytes from A_IMAGE. */
  const A_COPY_IMAGE = png(322, 124, Buffer.from("A's saved copy picture for the route guard"));
  const COPY_NONCE = "0123456789abcdef0123456789abcdef";
  const copyDirs: string[] = [];
  afterEach(() => {
    for (const dir of copyDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** Gives A's link a copy whose picture 1 is stored. */
  const storeCopyImage = async (world: World, linkId: string, bytes: Buffer) => {
    const url = "https://a.example/copy-picture.png";
    const draft = {
      markdown: `![pic](${imageRef(1, COPY_NONCE)})`,
      imageUrls: [url],
      nonce: COPY_NONCE,
    };
    const limits = copyLimits(1_000_000);
    expect(await world.savedCopies.saveCopy(A, linkId, draft, limits, new Date())).toBe("saved");
    const saved = await world.savedCopies.saveCopyImage(
      A,
      linkId,
      1,
      url,
      { contentType: "image/png", bytes },
      limits,
    );
    expect(saved).not.toBe(false);
  };

  /** Records the link's snapshot as fetched with `imageUrl`, so its image is pending. */
  const recordImageUrl = async (world: World, linkId: string, imageUrl: string) => {
    world.links
      .prepare(
        `UPDATE snapshots SET fetch_status = 'ok', next_fetch_at = NULL, image_url = ?,
           image_status = 'pending' WHERE link_id = ?`,
      )
      .run(imageUrl, Number(linkId));
  };
  const storeImage = async (world: World, linkId: string, bytes: Buffer) => {
    const imageUrl = "https://a.example/stored.png";
    await recordImageUrl(world, linkId, imageUrl);
    const images = new SqliteImageStore(world.links);
    expect(
      await images.writeImage(A, linkId, imageUrl, { contentType: "image/png", bytes }, new Date()),
    ).toBe(true);
  };

  type Marker = string | Buffer | string[];
  type ReadEntry = { request: string; marker: (world: World) => Marker } | { noOwnerData: string };
  const READ_ROUTES: Record<string, ReadEntry> = {
    // A's titled link has no why, so it is one of A's picks on home; A's pinned space and kept tool show too.
    "GET /": {
      request: "/",
      marker: () => ["Quokka habitat notes", A_TAG_NAME, A_TOOL_TITLE],
    },
    "GET /search": { request: "/search?q=quokka", marker: () => A_URL },
    "GET /spaces": {
      request: `/spaces?tag=${encodeURIComponent(A_TAG_NAME)}`,
      marker: () => [A_TAG_NAME, A_URL],
    },
    "GET /spaces/done": {
      request: `/spaces/done?tag=${encodeURIComponent(A_TAG_NAME)}`,
      marker: () => [A_TAG_NAME, A_DONE_URL],
    },
    "GET /all": { request: "/all", marker: () => [A_URL, A_TAG_NAME] },
    "GET /all/done": { request: "/all/done", marker: () => A_UNTAGGED_DONE_URL },
    "GET /connections": {
      request: "/connections",
      marker: () => ["<strong>Claude</strong>", `<strong>${A_KEY_NAME}</strong>`],
    },
    "GET /profile": {
      request: "/profile",
      marker: () => "A private note for the route guard",
    },
    "GET /login": { noOwnerData: "the sign-in form, served to anyone" },
    "GET /consent": {
      noOwnerData: "names the client in the signed authorize query, no owner data",
    },
    "GET /oauth-error": { noOwnerData: "fixed text chosen by the error code" },
    "GET /save": { noOwnerData: "the save form, filled only from its own query" },
    "GET /tags": { request: "/tags", marker: () => A_TAG_NAME },
    "GET /images/:id{[0-9]+}": { request: "/images/:id", marker: () => A_IMAGE },
    "GET /links/:id{[0-9]+}/copy/images/:n{[0-9]{1,2}}": {
      request: "/links/:id/copy/images/1",
      marker: () => A_COPY_IMAGE,
    },
  };
  const readKey = (path: string) => `GET ${path}`;
  const readablePaths = (world: World) => {
    const routes = webRoutes(world);
    return new Set(
      routes
        .filter(
          (r) =>
            r.method === "GET" ||
            (r.method === "ALL" &&
              routes.filter((o) => o.path === r.path).every((o) => o.method === "ALL")),
        )
        .map((r) => r.path),
    );
  };

  it("every readable web path has a READ_ROUTES entry, and no entry names a missing route", async () => {
    const readable = [...readablePaths(await oauthWorld())].map(readKey);
    for (const key of readable) {
      expect(
        Object.keys(READ_ROUTES),
        `${key} has no READ_ROUTES entry: add a sample request with A's marker, or a noOwnerData reason`,
      ).toContain(key);
    }
    for (const key of Object.keys(READ_ROUTES)) {
      expect(readable, `READ_ROUTES has an entry for ${key}, which is not a route`).toContain(key);
    }
  });

  const textOf = (marker: Marker) => (Array.isArray(marker) ? marker : [marker]);
  const holds = (sent: Sent, marker: string | Buffer) =>
    typeof marker === "string"
      ? sent.bytes.toString("utf8").includes(marker)
      : sent.bytes.includes(marker);

  it("a signed-in B reaches none of A's data through any web path", async () => {
    const copyDir = mkdtempSync(join(tmpdir(), "aye-isolation-"));
    copyDirs.push(copyDir);
    const world = await oauthWorld({ savedCopyDir: copyDir });
    const a = await connectClaude(world);
    await saveLinkWith(world, a.access, A_URL);
    createAgentKey(world.keyStore, { owner: A, ownerName: "A", agent: A_KEY_NAME });
    const note = "A private note for the route guard";
    await addProfile(createDeps(world.links, new FakeEmbedder(DIMS)), A, "seed", {
      addNotes: [{ text: note, source: "stated" }],
    });
    const aLinkId = (
      world.links.prepare("SELECT id FROM links WHERE owner_id = ?").get(A) as { id: string }
    ).id;
    await updateLink(createDeps(world.links, new FakeEmbedder(DIMS)), A, aLinkId, {
      title: "Quokka habitat notes",
      tags: [{ name: A_TAG_NAME, source: "stated" }],
    });
    await storeImage(world, aLinkId, A_IMAGE);
    await storeCopyImage(world, String(aLinkId), A_COPY_IMAGE);
    // A second link whose page named a remote image and has none stored: its card must not
    // fall back to the remote URL, or A's search page makes an outside request.
    const { link: remote } = await saveLink(createDeps(world.links, new FakeEmbedder(DIMS)), A, {
      url: A_DONE_URL,
      savedBy: "seed",
      title: "Quokka burrow photos",
    });
    await recordImageUrl(world, remote.id, "https://images.example/quokka.png");
    // A's tag is a space (on home), and the remote-image link is done in it (the done view).
    const seedDeps = createDeps(world.links, new FakeEmbedder(DIMS));
    await setTagPinned(seedDeps, A, { name: A_TAG_NAME, pinned: true });
    await updateLink(seedDeps, A, remote.id, {
      tags: [{ name: A_TAG_NAME, source: "stated" }],
      state: "archived",
    });
    // A done link with no tag is on no space page: All links' done view is its way back.
    const { link: untagged } = await saveLink(seedDeps, A, {
      url: A_UNTAGGED_DONE_URL,
      savedBy: "seed",
    });
    await updateLink(seedDeps, A, untagged.id, { state: "archived" });
    // A kept tool is on A's Handy shelf, and only there: kept tools are not Worth a look picks.
    const { link: handy } = await saveLink(seedDeps, A, {
      url: "https://a.example/keeper-login",
      savedBy: "seed",
      title: A_TOOL_TITLE,
    });
    await keepHandy(seedDeps, A, handy.id, "stated");
    const browser = await addSecondUser(world);
    await saveLink(createDeps(world.links, new FakeEmbedder(DIMS)), B, {
      url: B_URL,
      savedBy: "seed-b",
      title: "Quokka field guide",
    });
    const owner = world.agent();
    await owner.signIn();
    const aSearch = await owner.send("/search?q=quokka");
    expect(aSearch.status).toBe(200);
    expect(String(aSearch.body)).toContain(A_URL);
    const routes = webRoutes(world);
    const paths = [...new Set(routes.map((r) => r.path))];
    expect(paths).toContain("/connections");
    const readable = readablePaths(world);

    const asA = async (request: string, label: string) => {
      const sent = await owner.send(request);
      expect(sent.status, `A's ${label}`).not.toBe(404);
      if (/text\/html/.test(sent.headers.get("content-type") ?? "")) {
        expect(
          outsideRefs(sent.bytes.toString("utf8")),
          `A's ${label} makes an outside request`,
        ).toEqual([]);
      }
      return sent;
    };
    const asB = async (request: string, label: string) => {
      const sent = await browser.send(request);
      expect(sent.status, `B's ${label}`).not.toBe(500);
      return sent;
    };

    for (const path of paths) {
      if (readable.has(path)) await asA(fillPath(path, aLinkId), `GET ${path}`);
    }
    const executed = Object.entries(READ_ROUTES).flatMap(([key, entry]) =>
      "request" in entry
        ? [
            {
              key,
              request: entry.request.replaceAll(":id", aLinkId),
              marker: entry.marker(world),
            },
          ]
        : [],
    );
    const sentByA = new Map<string, Sent>();
    for (const { key, request, marker } of executed) {
      const sent = await asA(request, key);
      expect(sent.status, `A's ${key} (${request})`).toBe(200);
      for (const m of textOf(marker)) {
        expect(holds(sent, m), `A's ${key} (${request}) should show its marker`).toBe(true);
      }
      sentByA.set(key, sent);
    }

    const before = rowsOf(world, A);
    expect((await browser.send("/")).status).toBe(200);
    expect(String((await browser.send("/search?q=quokka")).body)).toContain(B_URL);
    const everyMarker = [A_URL, note, ...executed.flatMap((e) => textOf(e.marker))];
    for (const { key, request } of executed) {
      const sent = await asB(request, `${key} (${request})`);
      expect(
        sent.bytes.equals(sentByA.get(key)?.bytes ?? Buffer.alloc(0)) && sent.status === 200,
        `B's ${key} (${request}) is byte-for-byte what A got`,
      ).toBe(false);
      for (const m of everyMarker) {
        expect(holds(sent, m), `B's ${key} (${request}) shows A's data`).toBe(false);
      }
    }
    for (const path of paths) {
      const sent = await asB(fillPath(path, aLinkId), `GET ${path}`);
      for (const m of everyMarker) {
        expect(holds(sent, m), `B's GET ${path} shows A's data`).toBe(false);
      }
    }
    expect(rowsOf(world, A)).toEqual(before);
  });

  /** Each web route that can change data, and the two-owner test that covers it. */
  const WRITE_ROUTES_TESTED: Record<string, string> = {
    "POST /connections/disconnect": "T9, T11 and the two-owner disconnect test in web/http.test.ts",
    "POST /connections/keys": "the two-owner agent keys test in web/http.test.ts",
    "POST /connections/keys/turn-off": "the two-owner agent keys test in web/http.test.ts",
    "POST /connections/keys/turn-on": "the two-owner agent keys test in web/http.test.ts",
    "POST /home/opened": "the two-owner test of POST /home/opened in web/home-routes.test.ts",
    "POST /home/snooze": "the two-owner test of POST /home/snooze in web/home-routes.test.ts",
    "POST /home/unsnooze": "the two-owner test of POST /home/unsnooze in web/home-routes.test.ts",
    "POST /home/archive": "the two-owner test of POST /home/archive in web/home-routes.test.ts",
    "POST /home/unarchive": "the two-owner test of POST /home/unarchive in web/home-routes.test.ts",
    "POST /home/why": "the two-owner test of POST /home/why in web/home-routes.test.ts",
    "POST /links/opened": "the two-owner test of POST /links/opened in web/home-routes.test.ts",
    "POST /links/edit": "the two-owner test of POST /links/edit in web/edit-routes.test.ts",
    "POST /links/edit/undo":
      "the two-owner test of POST /links/edit/undo in web/edit-routes.test.ts",
    "POST /tools/keep": "the two-owner test of POST /tools/keep in web/tools-routes.test.ts",
    "POST /tools/not-handy":
      "the two-owner test of POST /tools/not-handy in web/tools-routes.test.ts",
    "POST /tools/still-using":
      "the two-owner test of POST /tools/still-using in web/tools-routes.test.ts",
    "POST /tools/suggestion":
      "the two-owner test of POST /tools/suggestion in web/tools-routes.test.ts",
    "POST /tools/undo": "the two-owner test of POST /tools/undo in web/tools-routes.test.ts",
    "POST /links/still-works":
      "the two-owner test of POST /links/still-works in web/gone-routes.test.ts",
    "POST /links/still-works/undo":
      "the two-owner test of POST /links/still-works/undo in web/gone-routes.test.ts",
    "POST /tags/pin": "the two-owner tag actions test in web/tags-routes.test.ts",
    "POST /tags/color": "the two-owner tag actions test in web/tags-routes.test.ts",
    "POST /tags/kind": "the two-owner tag actions test in web/tags-routes.test.ts",
    "POST /tags/status": "the two-owner tag actions test in web/tags-routes.test.ts",
    "POST /profile/notes/add": "the two-owner profile tests in web/profile-page.test.ts",
    "POST /profile/notes/edit": "the two-owner profile tests in web/profile-page.test.ts",
    "POST /profile/notes/confirm": "the two-owner profile tests in web/profile-page.test.ts",
    "POST /profile/notes/remove": "the two-owner profile tests in web/profile-page.test.ts",
    "POST /profile/notes/restore": "the two-owner profile tests in web/profile-page.test.ts",
    "POST /save": "the two-owner test of POST /save in web/save-routes.test.ts",
  };

  it("every web route that can write has a named two-owner test", async () => {
    const routes = webRoutes(await oauthWorld());
    const writes = new Set<string>();
    for (const r of routes) {
      const onlyAll = routes.filter((o) => o.path === r.path).every((o) => o.method === "ALL");
      // A path registered only with ALL answers every method, writes included.
      if (WRITE_METHODS.includes(r.method) || (r.method === "ALL" && onlyAll)) {
        writes.add(`${r.method} ${r.path}`);
      }
    }
    expect([...writes].sort()).toEqual(Object.keys(WRITE_ROUTES_TESTED).sort());
  });
});

describe("owner isolation in search", () => {
  it("T7: B's search finds B's link though A saved sixty newer links with the same words", async () => {
    const { world } = await fixture();
    const key = (owner: string, agent: string) =>
      createAgentKey(world.keyStore, { owner, ownerName: owner, agent }).key;
    const [a, b] = [key(A, "agent-a"), key(B, "agent-b")];
    const mine = await tool<SavedLink>(world, b, "save_link", { url: B_URL, title: "secretword" });
    const deps = createDeps(world.links, new FakeEmbedder(DIMS));
    for (let i = 0; i < 60; i++) {
      await saveLink(deps, A, { url: `https://a.example/${i}`, title: "secretword", savedBy: "t" });
    }
    const before = rowsOf(world, A);
    expect(before.links).toHaveLength(60);

    const found = await tool<Found>(world, b, "search_links", { query: "secretword", limit: 1 });
    const theirs = await tool<Found>(world, a, "search_links", { query: "secretword", limit: 50 });

    expect(found.links.map((l) => l.id)).toEqual([mine.link.id]);
    expect(theirs.links).toHaveLength(50);
    expect(theirs.links.map((l) => l.id)).not.toContain(mine.link.id);
  });
});

describe("owner isolation in OAuth grants", () => {
  const ownersOfLinks = (world: World) =>
    world.links.prepare("SELECT owner_id AS owner, url FROM links ORDER BY id").all();

  it("T9: B connecting, refreshing and disconnecting the same app leaves A's grants and A's refresh working", async () => {
    const world = await oauthWorld();
    const a = await connectClaude(world);
    const grantsA = grantsOf(world, A);
    expect(grantsA.every((rows) => rows.length > 0)).toBe(true);
    const browser = await addSecondUser(world);
    const b = await connectAs(world, browser, CLAUDE_ID, CLAUDE_REDIRECT);

    const refreshed = await refresh(world, b.refresh, { client_id: CLAUDE_ID });
    expect(refreshed.status).toBe(200);
    expect(grantsOf(world, A)).toEqual(grantsA);
    const gone = await browser.send("/connections/disconnect", {
      method: "POST",
      json: { clientId: CLAUDE_ID },
    });
    expect(gone.status).toBe(204);

    expect(grantsOf(world, A)).toEqual(grantsA);
    expect(grantsOf(world, B)).toEqual([[], [], []]);
    expect((await saveLinkWith(world, b.access, B_URL)).status).toBe(401);
    const again = await refresh(world, a.refresh, { client_id: CLAUDE_ID });
    expect(again.status).toBe(200);
    expect((await saveLinkWith(world, field(again, "access_token"), A_URL)).status).toBe(200);
    expect(ownersOfLinks(world)).toEqual([{ owner: A, url: A_URL }]);
  });

  it("T10: B can authorize a client registered with A's cookie, and its token acts only for B", async () => {
    const world = await oauthWorld();
    const registrar = world.agent();
    await registrar.signIn();
    const registered = await registrar.send("/api/auth/oauth2/register", {
      method: "POST",
      json: {
        client_name: "Shared App",
        redirect_uris: [DCR_REDIRECT],
        token_endpoint_auth_method: "none",
      },
    });
    const clientId = field(registered, "client_id");
    expect(
      world.db.prepare("SELECT userId FROM oauthClient WHERE clientId = ?").get(clientId),
    ).toEqual({ userId: A });
    const p = pkce();
    const { code } = await approve(world, clientId, DCR_REDIRECT, { challenge: p.challenge });
    const a = field(
      await exchange(world, code, p.verifier, { client_id: clientId, redirect_uri: DCR_REDIRECT }),
      "access_token",
    );
    const grantsA = grantsOf(world, A);
    expect(grantsA.every((rows) => rows.length > 0)).toBe(true);

    const b = await connectAs(world, await addSecondUser(world), clientId, DCR_REDIRECT);

    expect((await saveLinkWith(world, b.access, B_URL)).status).toBe(200);
    expect(ownersOfLinks(world)).toEqual([{ owner: B, url: B_URL }]);
    expect(grantsOf(world, A)).toEqual(grantsA);
    expect((await saveLinkWith(world, a, A_URL)).status).toBe(200);
    expect(ownersOfLinks(world)).toEqual([
      { owner: B, url: B_URL },
      { owner: A, url: A_URL },
    ]);
  });
});

describe("owner isolation through the web session door", () => {
  it("T11: B's cookie shows only B's links, cannot name another owner, and is no credential for /mcp", async () => {
    const world = await oauthWorld();
    const a = await connectClaude(world);
    await saveLinkWith(world, a.access, A_URL);
    const browser = await addSecondUser(world);
    await saveLinkWith(world, await connectClaudeAs(world, browser), B_URL);
    const deps = createDeps(world.links, new FakeEmbedder(DIMS));
    for (const owner of [A, B]) {
      const { id } = world.links.prepare("SELECT id FROM links WHERE owner_id = ?").get(owner) as {
        id: string;
      };
      await updateLink(deps, owner, id, { title: `Quokka notes of ${owner}` });
    }
    const before = { rows: rowsOf(world, A), grants: grantsOf(world, A) };
    const total = world.links.prepare("SELECT count(*) AS n FROM links").get();

    const home = await browser.send(`/search?q=quokka&owner=${A}`);
    const gone = await browser.send("/connections/disconnect", {
      method: "POST",
      json: { clientId: CLAUDE_ID, owner: A },
    });
    const mcp = await browser.send("/mcp", {
      method: "POST",
      origin: false,
      headers: { host: "links.example", accept: "application/json, text/event-stream" },
      json: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "save_link", arguments: { url: "https://b.example/by-cookie" } },
      },
    });

    expect(home.status).toBe(200);
    expect(String(home.body)).toContain(B_URL);
    expect(String(home.body)).not.toContain(A_URL);
    expect(gone.status).toBe(204);
    expect(mcp.status).toBe(401);
    expect(world.links.prepare("SELECT count(*) AS n FROM links").get()).toEqual(total);
    expect({ rows: rowsOf(world, A), grants: grantsOf(world, A) }).toEqual(before);
    expect((await saveLinkWith(world, a.access, "https://a.example/still")).status).toBe(200);
  });
});
