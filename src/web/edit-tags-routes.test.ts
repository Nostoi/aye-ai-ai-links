import { describe, expect, it } from "vitest";
import { addSecondUser, allRows, type World } from "../auth/oauth-test-kit.js";
import { TAGS_CONFLICT } from "../core/link-edit.js";
import { updateLink } from "../core/links.js";
import {
  type Answer,
  edit,
  edited,
  file,
  linkDeps,
  MINE,
  ownedRows,
  undo,
} from "./edit-routes-kit.js";

const A = "owner";
const KITCHEN = { key: "kitchen", source: "stated" };
const GUESS = { key: "guess", source: "inferred" };

/** The edited link, tagged Kitchen (a pinned clay space) and Guess (an AI's guess), A signed in. */
async function tagged() {
  const ctx = await edited();
  const deps = linkDeps(ctx.world);
  await updateLink(deps, A, ctx.id, {
    tags: [
      { name: "Kitchen", source: "stated" },
      { name: "Guess", source: "inferred" },
    ],
  });
  await deps.store.pinTag(A, "kitchen", { pinned: true, color: "clay" });
  return ctx;
}
const tagFields = (names: string[], seen = [KITCHEN, GUESS]) => ({
  tags: JSON.stringify(names),
  seen: JSON.stringify(seen),
});
const rowsOf = (world: World, id: string) =>
  world.links
    .prepare(
      `SELECT t.key, lt.source FROM link_tags lt JOIN tags t ON t.id = lt.tag_id
       WHERE lt.link_id = ? ORDER BY lt.position`,
    )
    .all(Number(id));

describe("tags in POST /links/edit and its Undo", () => {
  it("writes the names in order, a kept tag with its seen source and a new one as stated, and answers them", async () => {
    const { world, browser, id } = await tagged();
    const res = await edit(browser, { id, ...tagFields(["Guess", "Kitchen", "Quokkas"]) });
    expect(res.status).toBe(200);
    const body = res.body as Answer;
    expect(body.tags).toEqual([
      { key: "guess", name: "Guess", source: "inferred" },
      { key: "kitchen", name: "Kitchen", source: "stated" },
      { key: "quokkas", name: "Quokkas", source: "stated" },
    ]);
    expect(body.editId).toEqual(expect.any(String));
    expect(rowsOf(world, id)).toEqual([
      { key: "guess", source: "inferred" },
      { key: "kitchen", source: "stated" },
      { key: "quokkas", source: "stated" },
    ]);
    const catalog = world.links.prepare("SELECT key FROM tags WHERE owner_id = ?").all(A);
    expect(catalog).toContainEqual({ key: "quokkas" });
  });

  it("answers the card's space from the new tags: the first pinned one, or the list's within space", async () => {
    const { world, browser, id } = await tagged();
    const deps = linkDeps(world);
    await updateLink(deps, A, id, { tags: [{ name: "Garden", source: "stated" }] });
    await deps.store.pinTag(A, "garden", { pinned: true, color: "green" });
    const garden = [{ key: "garden", source: "stated" }];
    const first = await edit(browser, { id, ...tagFields(["Kitchen", "Garden"], garden) });
    expect((first.body as Answer).space).toEqual({ color: "clay" });
    expect((first.body as Answer).lineSpace).toEqual({ name: "Kitchen" });
    const both = [KITCHEN, { key: "garden", source: "stated" }];
    const again = await edit(browser, {
      id,
      ...tagFields(["Garden", "Kitchen"], both),
      within: "garden",
    });
    expect((again.body as Answer).space).toEqual({ color: "green" });
    expect((again.body as Answer).lineSpace).toEqual({ name: "Garden" });
  });

  it("leaves the grey line's space out only on the space page's own list (own)", async () => {
    const { browser, id } = await tagged();
    const send = (extra: Record<string, string>) =>
      edit(browser, { id, ...tagFields(["Kitchen"]), ...extra });
    const own = (await send({ within: "kitchen", own: "1" })).body as Answer;
    expect(own.space).toEqual({ color: "clay" });
    expect(own.lineSpace).toBeNull();
    // Undo, then the same edit within a search: the line names the space.
    expect((await undo(browser, { id, editId: own.editId })).status).toBe(200);
    const search = (await send({ within: "kitchen" })).body as Answer;
    expect(search.lineSpace).toEqual({ name: "Kitchen" });
  });

  it("Undo puts back the old tags, sources and order with the title, and answers within and own", async () => {
    const { world, browser, id } = await tagged();
    const done = (await edit(browser, { id, title: "Retitled", ...tagFields(["Quokkas"]) }))
      .body as Answer;
    expect(done.space).toBeNull();
    const res = await undo(browser, { id, editId: done.editId, within: "kitchen", own: "1" });
    expect(res.status).toBe(200);
    const back = res.body as Answer;
    expect(back.title).toBe("Quokka habitat");
    expect(back.tags.map((t) => [t.key, t.source])).toEqual([
      ["kitchen", "stated"],
      ["guess", "inferred"],
    ]);
    expect(back.space).toEqual({ color: "clay" });
    expect(back.lineSpace).toBeNull();
    expect(rowsOf(world, id)).toEqual([
      { key: "kitchen", source: "stated" },
      { key: "guess", source: "inferred" },
    ]);
  });

  it("is a 409 in the owner's words when the link's tags changed since the dialog opened, and nothing is written", async () => {
    const { world, browser, id } = await tagged();
    await updateLink(linkDeps(world), A, id, { tags: [{ name: "Agent", source: "inferred" }] });
    const before = allRows(world);
    const res = await edit(browser, {
      id,
      title: "Retitled",
      picture: file(MINE),
      ...tagFields(["Quokkas"]),
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: "conflict", message: TAGS_CONFLICT });
    expect(allRows(world)).toEqual(before);
  });

  it("removing a tag and adding it back changes nothing: no edit id, and the guess stays a guess", async () => {
    const { world, browser, id } = await tagged();
    const before = allRows(world);
    const res = await edit(browser, { id, ...tagFields(["Kitchen", "Guess"]) });
    expect(res.status).toBe(200);
    expect((res.body as Answer).editId).toBeNull();
    expect(allRows(world)).toEqual(before);
  });

  it.each([
    ["tags without seen", { tags: "[]" }],
    ["seen without tags", { seen: "[]" }],
    ["tags that are not JSON", { tags: "{", seen: "[]" }],
    ["tags that are not an array", { tags: '"a"', seen: "[]" }],
    ["a tag that is not text", { tags: "[1]", seen: "[]" }],
    ["a tag over 200 characters", { tags: JSON.stringify(["a".repeat(201)]), seen: "[]" }],
    ["more than 50 tags", { tags: JSON.stringify(Array(51).fill("a")), seen: "[]" }],
    ["seen that is not an array", { tags: "[]", seen: "{}" }],
    ["a seen entry without a key", { tags: "[]", seen: '[{"source":"stated"}]' }],
    ["a seen entry without a source", { tags: "[]", seen: '[{"key":"a"}]' }],
    [
      "a seen key over 200 characters",
      { tags: "[]", seen: JSON.stringify([{ key: "a".repeat(201), source: "stated" }]) },
    ],
    [
      "more than 50 seen entries",
      { tags: "[]", seen: JSON.stringify(Array(51).fill({ key: "a", source: "stated" })) },
    ],
    ["own that is not 1", { own: "yes" }],
  ])("refuses %s with 400, and every row stays", async (_, fields) => {
    const { world, browser, id } = await tagged();
    const before = allRows(world);
    const res = await edit(browser, { id, ...fields });
    expect(res.status).toBe(400);
    expect(allRows(world)).toEqual(before);
  });

  it("refuses a within sent as a file with 400, and every row stays", async () => {
    const { world, browser, id } = await tagged();
    const before = allRows(world);
    expect((await edit(browser, { id, within: file(MINE) })).status).toBe(400);
    expect(allRows(world)).toEqual(before);
  });

  it("refuses an Undo body whose own is not 1, or within is not text, with 400", async () => {
    const { browser, id } = await tagged();
    const done = (await edit(browser, { id, ...tagFields(["Quokkas"]) })).body as Answer;
    expect((await undo(browser, { id, editId: done.editId, own: true })).status).toBe(400);
    expect((await undo(browser, { id, editId: done.editId, within: 3 })).status).toBe(400);
    expect((await undo(browser, { id, editId: done.editId })).status).toBe(200);
  });

  it("refuses a seen source that is not a source with 400 invalid_input, and every row stays", async () => {
    const { world, browser, id } = await tagged();
    const before = allRows(world);
    const res = await edit(browser, {
      id,
      ...tagFields(["Kitchen"], [{ key: "kitchen", source: "bogus" }]),
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_input" });
    expect(allRows(world)).toEqual(before);
  });

  it("refuses a blank tag name with 400 invalid_input and writes nothing, the title included", async () => {
    const { world, browser, id } = await tagged();
    const before = allRows(world);
    const res = await edit(browser, { id, title: "Retitled", ...tagFields(["Kitchen", " "]) });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_input" });
    expect(allRows(world)).toEqual(before);
  });

  it("B editing A's link's tags gets 404 and A's rows, catalog included, are unchanged", async () => {
    const { world, browser, id } = await tagged();
    const bBrowser = await addSecondUser(world);
    const before = ownedRows(world, A);
    const res = await edit(bBrowser, { id, ...tagFields(["Intruder"]) });
    expect(res.status).toBe(404);
    expect(ownedRows(world, A)).toEqual(before);
    expect(world.links.prepare("SELECT key FROM tags WHERE owner_id <> ?").all(A)).toEqual([]);
    // The same request from A is accepted, so B's 404 is down to whose link it is.
    expect((await edit(browser, { id, ...tagFields(["Intruder"]) })).status).toBe(200);
  });
});

describe("GET /tags/names", () => {
  it("lists the signed-in owner's tag names, uncached, and never another owner's", async () => {
    const { world, browser, id } = await edited();
    await updateLink(linkDeps(world), A, id, {
      tags: [
        { name: "Kitchen", source: "stated" },
        { name: "Garden", source: "inferred" },
      ],
    });
    const res = await browser.send("/tags/names");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect((res.body as { names: string[] }).names.sort()).toEqual(["Garden", "Kitchen"]);
    const b = await addSecondUser(world);
    expect((await b.send("/tags/names")).body).toEqual({ names: [] });
  });

  it("sends a signed-out caller to sign in", async () => {
    const { world } = await edited();
    expect((await world.agent().send("/tags/names")).status).toBe(302);
  });
});
