import { afterEach, describe, expect, it } from "vitest";
import { openToolSession, type ToolSession } from "../ai/tool-session.js";
import type { Caller } from "../auth/caller.js";
import { getDigest } from "../core/digest.js";
import { undoEdit } from "../core/link-edit.js";
import { saveLink } from "../core/links.js";
import type { LinkStore } from "../core/store.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";
import { createCallTracker } from "./call-tracker.js";
import type { McpDeps } from "./server.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const CALLER: Caller = { owner: "owner-a", savedBy: "In-app AI (Fake)" };
const URL = "https://example.com/zellige";

const open: { db: ReturnType<typeof openDatabase>; session?: ToolSession }[] = [];

function setup() {
  const db = openDatabase(":memory:");
  const deps = { ...createDeps(db, new FakeEmbedder(DIMS)), now: () => NOW };
  deps.store.ensureUser(CALLER.owner, CALLER.owner);
  const entry: (typeof open)[number] = { db };
  open.push(entry);
  return { db, deps, entry };
}

async function session(entry: (typeof open)[number], deps: McpDeps) {
  entry.session = await openToolSession(deps, CALLER, createCallTracker().track);
  return entry.session;
}

afterEach(async () => {
  for (const { db, session } of open.splice(0)) {
    await session?.close();
    db.close();
  }
});

describe("the change record", () => {
  it("lists a save whose handy step was refused", async () => {
    const { db, deps, entry } = setup();
    const s = await session(entry, deps);

    // A new link is not kept handy, so it has no still-using check to answer.
    const result = await s.call("save_link", {
      url: URL,
      handy: { action: "still_using", source: "stated" },
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('saved with id "1"');
    expect(db.prepare("SELECT id FROM links").all()).toEqual([{ id: 1 }]);
    expect(s.changes()).toEqual([
      { kind: "link", tool: "save_link", linkId: "1", created: true, fields: [], editId: null },
    ]);
  });

  // "lists the handy write of an update whose link write then failed" is left out: no input
  // reaches it. update_link checks the tags and title before the handy step, the schema refuses
  // bad states and dates, and a missing link fails the handy step first. Only another caller
  // deleting the link between the two writes gets there.

  it("records handy's own receipt", async () => {
    const { deps, entry } = setup();
    await saveLink(deps, CALLER.owner, { url: URL, savedBy: "seed" });
    const s = await session(entry, deps);

    await s.call("update_link", { id: "1", handy: { action: "keep", source: "stated" } });
    const after = await deps.tools.getTool(CALLER.owner, "1");
    const [first] = s.changes();
    const firstAsRecorded = structuredClone(first);
    await s.call("update_link", { id: "1", handy: { action: "keep", source: "asked" } });

    expect(after?.status).toBe("kept");
    expect(first).toEqual({ kind: "handy", linkId: "1", change: { previous: null, tool: after } });
    const changes = s.changes();
    expect(changes).toHaveLength(2);
    expect(changes[0]).toEqual(firstAsRecorded);
    expect(changes[1]).toEqual({
      kind: "handy",
      linkId: "1",
      change: { previous: after, tool: await deps.tools.getTool(CALLER.owner, "1") },
    });
  });

  it("names the link fields an update sent", async () => {
    const { deps, entry } = setup();
    await saveLink(deps, CALLER.owner, { url: URL, savedBy: "seed" });
    const s = await session(entry, deps);

    await s.call("update_link", {
      id: "1",
      why: { text: "choosing tiles", source: "stated" },
      tags: [{ name: "kitchen", source: "stated" }],
      snoozedUntil: "2026-11-01T00:00:00Z",
      handy: { action: "keep", source: "stated" },
    });

    const [handy, link] = s.changes();
    expect(handy?.kind).toBe("handy");
    expect(link).toMatchObject({ kind: "link", tool: "update_link", linkId: "1", created: false });
    expect(link?.kind === "link" && [...link.fields].sort()).toEqual([
      "snoozedUntil",
      "tags",
      "why",
    ]);
  });

  it("lists every link a digest marked, even one it left out", async () => {
    const { deps, entry } = setup();
    await saveLink({ ...deps, now: () => new Date("2026-10-01T09:00:00Z") }, CALLER.owner, {
      url: URL,
      savedBy: "seed",
    });
    await getDigest({ ...deps, now: () => new Date("2026-10-04T09:00:00Z") }, CALLER.owner);
    const store = deps.store;
    // Another caller gives the link its why after the digest picked it and before it claims it.
    const racing = Object.assign(Object.create(store) as LinkStore, {
      claimSurfaced: async (...args: Parameters<LinkStore["claimSurfaced"]>) => {
        await store.update(CALLER.owner, "1", {
          why: { text: "choosing tiles", source: "stated" },
        });
        return store.claimSurfaced(...args);
      },
    });
    const s = await session(entry, { ...deps, store: racing });

    const result = await s.call("get_digest", {});

    expect(result.isError).toBe(false);
    expect(result.structured).toEqual({ links: [] });
    expect((await store.get(CALLER.owner, "1"))?.lastSurfacedAt).toEqual(NOW);
    expect(s.changes()).toEqual([{ kind: "surfaced", linkIds: ["1"] }]);
  });

  it("lists a removed note with its text and source", async () => {
    const { deps, entry } = setup();
    const s = await session(entry, deps);
    await s.call("add_profile", { addNotes: [{ text: "training for a 10K", source: "stated" }] });

    const result = await s.call("edit_profile", { removeNotes: ["1"] });

    expect(result.isError).toBe(false);
    expect(s.changes()[1]).toEqual({
      kind: "profile",
      added: [],
      edited: [],
      removed: [{ entry: "note", id: "1", text: "training for a 10K", source: "stated" }],
    });
  });

  it("lists an edited note as it was written", async () => {
    const { deps, entry } = setup();
    const s = await session(entry, deps);
    await s.call("add_profile", { addNotes: [{ text: "likes long reads", source: "inferred" }] });

    await s.call("edit_profile", {
      editNotes: [{ id: "1", text: "  likes long essays ", source: "asked" }],
    });

    expect(s.changes()[1]).toEqual({
      kind: "profile",
      added: [],
      edited: [{ entry: "note", id: "1", text: "likes long essays", source: "asked" }],
      removed: [],
    });
  });

  it("tells an added focus entry from a note, with its source", async () => {
    const { deps, entry } = setup();
    const s = await session(entry, deps);

    await s.call("add_profile", {
      addNotes: [{ text: "likes long reads", source: "inferred" }],
      addFocus: [{ text: "kitchen remodel", source: "stated" }],
    });

    expect(s.changes()).toEqual([
      {
        kind: "profile",
        added: [
          { entry: "note", id: "1", text: "likes long reads", source: "inferred" },
          { entry: "focus", id: "1", text: "kitchen remodel", source: "stated" },
        ],
        edited: [],
        removed: [],
      },
    ]);
  });

  it("lists every focus entry one call added, past the recent-focus limit", async () => {
    const { deps, entry } = setup();
    const s = await session(entry, deps);
    const addFocus = Array.from({ length: 12 }, (_, k) => ({ text: `f${k}`, source: "stated" }));

    await s.call("add_profile", { addFocus });

    const [change] = s.changes();
    expect(change?.kind === "profile" && change.added.map((e) => e.text)).toEqual(
      addFocus.map((f) => f.text),
    );
  });

  it("records the edit id of an update, and Undo restores the summary", async () => {
    const { deps, entry } = setup();
    await saveLink(deps, CALLER.owner, { url: URL, summary: "old summary", savedBy: "seed" });
    const s = await session(entry, deps);

    await s.call("update_link", { id: "1", summary: "new summary" });

    const [change] = s.changes();
    expect(change).toMatchObject({ kind: "link", tool: "update_link", editId: expect.any(String) });
    const editId = change?.kind === "link" ? change.editId : null;
    expect((await deps.store.get(CALLER.owner, "1"))?.summary).toBe("new summary");
    await undoEdit(deps, CALLER.owner, "1", editId as string);
    expect((await deps.store.get(CALLER.owner, "1"))?.summary).toBe("old summary");
  });

  it("records no edit id for an update that changes no covered field", async () => {
    const { deps, entry } = setup();
    await saveLink(deps, CALLER.owner, { url: URL, savedBy: "seed" });
    const s = await session(entry, deps);

    await s.call("update_link", { id: "1", state: "archived" });

    expect(s.changes()).toMatchObject([{ kind: "link", tool: "update_link", editId: null }]);
  });

  it("lists a repeat save that filled the why, and not one that didn't", async () => {
    const { deps, entry } = setup();
    const s = await session(entry, deps);
    const repeat = { url: URL, why: { text: "choosing kitchen tiles", source: "stated" } };

    await s.call("save_link", { url: URL });
    await s.call("save_link", repeat);
    await s.call("save_link", repeat);

    expect(s.changes()).toEqual([
      { kind: "link", tool: "save_link", linkId: "1", created: true, fields: [], editId: null },
      {
        kind: "link",
        tool: "save_link",
        linkId: "1",
        created: false,
        fields: ["why"],
        editId: expect.any(String),
      },
    ]);
  });

  it("lists tag kind changes one by one", async () => {
    const { deps, entry } = setup();
    await saveLink(deps, CALLER.owner, {
      url: URL,
      savedBy: "seed",
      tags: [
        { name: "kitchen", source: "stated" },
        { name: "garden", source: "stated" },
      ],
    });
    const s = await session(entry, deps);

    await s.call("update_tag", { name: "kitchen", kind: "project" });
    await s.call("update_tag", { name: "garden", kind: "project" });

    expect(s.changes()).toEqual([
      { kind: "tag", name: "kitchen", tagKind: "project" },
      { kind: "tag", name: "garden", tagKind: "project" },
    ]);
  });

  it("records nothing for reads and refusals that wrote nothing", async () => {
    const { deps, entry } = setup();
    await saveLink(deps, CALLER.owner, {
      url: URL,
      savedBy: "seed",
      why: { text: "w", source: "stated" },
    });
    await getDigest(deps, CALLER.owner);
    const s = await session(entry, deps);

    const calls: [string, unknown, boolean][] = [
      ["search_links", { query: "tiles" }, false],
      ["list_links", {}, false],
      ["get_link", { id: "1" }, false],
      ["get_profile", {}, false],
      // The one link was surfaced just now: the digest has nothing to mark.
      ["get_digest", {}, false],
      // A repeat save whose why is already set changes nothing.
      ["save_link", { url: URL, why: { text: "other", source: "stated" } }, false],
      // Only handy was sent, and it was refused; the link write had nothing to write.
      ["update_link", { id: "1", handy: { action: "still_using", source: "stated" } }, true],
      ["update_link", { id: "999", summary: "s" }, true],
      ["update_tag", { name: "nothing", kind: "project" }, true],
      ["add_profile", {}, true],
      ["edit_profile", { removeNotes: ["999"] }, true],
      ["save_link", { url: "ftp://example.com/x" }, true],
    ];
    for (const [name, args, refused] of calls) {
      expect((await s.call(name, args)).isError, name).toBe(refused);
    }

    expect(s.changes()).toEqual([]);
  });
});
