import { describe, expect, it } from "vitest";
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
  saveLinkWith,
  type World,
} from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { addProfile } from "../core/profile.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

/**
 * Owner isolation through every door, with real credentials: agent keys, OAuth access tokens and
 * web sessions. Each test shows what B's request did and that A's rows are exactly as they were.
 */

const A = "owner";
const B = SECOND_USER.id;
const A_URL = "https://a.example/secret";
const B_URL = "https://b.example/mine";

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

// Every table that holds A's rows. SELECT * so a change to any column shows.
const OWNED = [
  "links",
  "tags",
  "link_tags",
  "profile_notes",
  "focus_log",
  "search_log",
  "snapshots",
  "link_vectors",
];
const rowsOf = (world: World, owner: string) =>
  Object.fromEntries(
    OWNED.map((t) => [
      t,
      world.links.prepare(`SELECT * FROM ${t} WHERE owner_id = ? ORDER BY rowid`).all(owner),
    ]),
  );
const grantsOf = (world: World, userId: string) =>
  ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"].map((t) =>
    world.db.prepare(`SELECT * FROM ${t} WHERE userId = ? ORDER BY id`).all(userId),
  );

type Door = { a: string; b: string; savedByB: string };
const doors: Record<string, (world: World) => Promise<Door>> = {
  "agent key": async (world) => ({
    a: createAgentKey(world.keyStore, { owner: A, ownerName: "A", agent: "agent-a" }),
    b: createAgentKey(world.keyStore, { owner: B, ownerName: "B", agent: "agent-b" }),
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
    const before = snapA();
    const everything = {
      title: "hijack",
      summary: "hijack",
      why: { text: "hijack", source: "stated" },
      tags: [{ name: "Hijack", source: "stated" }],
      state: "archived",
      snoozedUntil: "2099-01-01T00:00:00Z",
      opened: true,
      owner: A,
    };

    await refused(world, door.b, "update_link", { id: aId, ...everything }, NO_LINK);

    expect(snapA()).toEqual(before);
    // The same arguments are valid on B's own link, so the refusal above was about ownership.
    const own = await tool<{ link: { title: string } }>(world, door.b, "update_link", {
      id: bId,
      ...everything,
    });
    expect(own.link.title).toBe("hijack");
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
});

describe("owner isolation in search", () => {
  it("T7: B's search finds B's link though A saved sixty newer links with the same words", async () => {
    const { world } = await fixture();
    const key = (owner: string, agent: string) =>
      createAgentKey(world.keyStore, { owner, ownerName: owner, agent });
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
    const before = { rows: rowsOf(world, A), grants: grantsOf(world, A) };
    const total = world.links.prepare("SELECT count(*) AS n FROM links").get();

    const home = await browser.send(`/?owner=${A}`);
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
