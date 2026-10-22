import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { AUTH_BODY_LIMIT } from "../auth/http.js";
import { addSecondUser, allRows } from "../auth/oauth-test-kit.js";
import { png, svg } from "../core/image-test-kit.js";
import { MAX_IMAGE_BYTES } from "../core/image-type.js";
import { deleteLink } from "../core/link-removal.js";
import { updateLink, updateLinkWithReceipt } from "../core/links.js";
import { SqliteImageStore } from "../store/sqlite-image-store.js";
import {
  A,
  type Answer,
  edit,
  edited,
  file,
  form,
  linkDeps,
  MINE,
  ownedRows,
  PAGE,
  URL,
  undo,
  v,
} from "./edit-routes-kit.js";

const BAD = "That picture can't be used. Try a PNG, JPEG, GIF or WebP under 2 MB.";

describe("POST /links/edit", () => {
  it("sets the owner's picture: 200, uncached, with the card's new state and an edit id; the fetched one stays", async () => {
    const { world, browser, id } = await edited();
    const res = await edit(browser, { id, picture: file(MINE, "application/octet-stream") });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toEqual({
      title: "Quokka habitat",
      shown: "Quokka habitat",
      url: URL,
      initials: "QH",
      version: v(MINE),
      fit: "cover",
      picture: { own: true, pageVersion: v(PAGE), pageFit: "cover" },
      tags: [],
      space: null,
      lineSpace: null,
      editId: expect.any(String),
    });
    // The type stored is the one the header names, not the part's.
    expect(world.links.prepare("SELECT content_type FROM owner_images").get()).toEqual({
      content_type: "image/png",
    });
    expect((await browser.send(`/images/${id}`)).bytes.equals(MINE)).toBe(true);
    expect((await browser.send(`/images/${id}?page=1`)).bytes.equals(PAGE)).toBe(true);
  });

  it("changes only the title it is sent, through the title rule, and the picture stays", async () => {
    const { browser, id } = await edited();
    const trimmed = (await edit(browser, { id, title: "  Quokka burrows " })).body as Answer;
    expect(trimmed).toMatchObject({
      title: "Quokka burrows",
      version: v(PAGE),
      fit: "cover",
      picture: { own: false },
    });
    const blank = (await edit(browser, { id, title: " " })).body as Answer;
    expect(blank).toMatchObject({ title: null, url: URL });
  });

  it("answers the title the card shows: the page's own for a link with none, the stored one otherwise", async () => {
    const { browser, id } = await edited();
    const named = (await edit(browser, { id, title: "New" })).body as Answer;
    expect(named).toMatchObject({ title: "New", shown: "New" });
    const cleared = (await edit(browser, { id, title: " " })).body as Answer;
    expect(cleared).toMatchObject({ title: null, shown: "Quokkas: a field guide" });
    const picture = (await edit(browser, { id, picture: file(MINE) })).body as Answer;
    expect(picture).toMatchObject({ title: null, shown: "Quokkas: a field guide" });
  });

  it("answers the readable fallback when Undo puts a missing title back", async () => {
    const { browser, id } = await edited();
    await edit(browser, { id, title: " " });
    const named = (await edit(browser, { id, title: "Chosen" })).body as Answer;
    expect(named.shown).toBe("Chosen");
    const back = await undo(browser, { id, editId: named.editId });
    expect(back.body).toMatchObject({ title: null, shown: "Quokkas: a field guide" });
  });

  it("'page' removes the owner's picture, so the page's shows again", async () => {
    const { browser, id } = await edited();
    await edit(browser, { id, picture: file(MINE) });
    const res = (await edit(browser, { id, picture: "page" })).body as Answer;
    expect(res).toMatchObject({
      version: v(PAGE),
      fit: "cover",
      picture: { own: false, pageVersion: v(PAGE), pageFit: "cover" },
    });
    expect(res.editId).toEqual(expect.any(String));
  });

  it("answers a form that changes nothing with no edit id, and every row stays", async () => {
    const { world, browser, id } = await edited();
    const before = allRows(world);
    const res = await edit(browser, { id, title: "Quokka habitat", picture: "page" });
    expect(res.status).toBe(200);
    expect((res.body as Answer).editId).toBeNull();
    expect(allRows(world)).toEqual(before);
  });

  it.each([
    [
      "a 201-character title",
      () => ({ title: "a".repeat(201) }),
      "A title can be at most 200 characters.",
    ],
    ["an SVG", () => ({ picture: file(svg, "image/svg+xml") }), BAD],
    [
      "a picture of 2 MiB + 1 byte",
      () => ({
        picture: file(Buffer.concat([MINE, Buffer.alloc(MAX_IMAGE_BYTES + 1 - MINE.length)])),
      }),
      BAD,
    ],
    ["a header over the pixel cap", () => ({ picture: file(png(10_001, 4000)) }), BAD],
    ["an empty picture file", () => ({ picture: file(Buffer.alloc(0)) }), BAD],
  ])("refuses %s with 400 in core's words, and every row stays", async (_, fields, message) => {
    const { world, browser, id } = await edited();
    const before = allRows(world);
    const res = await edit(browser, { id, ...fields() });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: "invalid_input", message });
    expect(allRows(world)).toEqual(before);
  });
});

describe("POST /links/edit/undo", () => {
  it("puts the edit back, answering the card's state; a second Undo is a 409 in core's words", async () => {
    const { world, browser, id } = await edited();
    const done = (await edit(browser, { id, title: "New", picture: file(MINE) })).body as Answer;
    const res = await undo(browser, { id, editId: done.editId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      title: "Quokka habitat",
      shown: "Quokka habitat",
      url: URL,
      initials: "QH",
      version: v(PAGE),
      fit: "cover",
      picture: { own: false, pageVersion: v(PAGE), pageFit: "cover" },
      tags: [],
      space: null,
      lineSpace: null,
    });
    const before = allRows(world);
    const again = await undo(browser, { id, editId: done.editId });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({
      code: "conflict",
      message: "This link changed since, so nothing was undone.",
    });
    expect(allRows(world)).toEqual(before);
  });

  it("is a 409 after an AI changed the title, keeping the AI's title", async () => {
    const { world, browser, id } = await edited();
    const done = (await edit(browser, { id, title: "Mine" })).body as Answer;
    await updateLink(linkDeps(world), A, id, { title: "Agent's" });
    expect((await undo(browser, { id, editId: done.editId })).status).toBe(409);
    expect(world.links.prepare("SELECT title FROM links WHERE id = ?").get(Number(id))).toEqual({
      title: "Agent's",
    });
  });
});

describe("owner isolation and refusals", () => {
  it("POST /links/edit acts for the signed-in owner only: B naming A's link gets 404 and A's rows are unchanged", async () => {
    const { world, browser, id } = await edited();
    const bBrowser = await addSecondUser(world);
    const before = ownedRows(world, A);
    const res = await edit(bBrowser, { id, title: "B's", picture: file(MINE) });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "not_found", message: "That link is gone. Reload the page." });
    expect(ownedRows(world, A)).toEqual(before);
    // The same request from A is accepted, so B's 404 is down to whose link it is.
    expect((await edit(browser, { id, title: "A's" })).status).toBe(200);
  });

  it("POST /links/edit/undo acts for the signed-in owner only: B naming A's link and edit gets 404 and A's rows are unchanged", async () => {
    const { world, browser, id } = await edited();
    const done = (await edit(browser, { id, title: "New" })).body as Answer;
    const bBrowser = await addSecondUser(world);
    const before = ownedRows(world, A);
    expect((await undo(bBrowser, { id, editId: done.editId })).status).toBe(404);
    expect(ownedRows(world, A)).toEqual(before);
    expect((await undo(browser, { id, editId: done.editId })).status).toBe(200);
  });

  it("POST /links/edit/undo with A's AI receipt: B gets 404 and A's summary, why, tags, catalog and receipt are unchanged", async () => {
    const { world, browser, id } = await edited();
    const { editId } = await updateLinkWithReceipt(linkDeps(world), A, id, {
      summary: "AI summary",
      why: { text: "AI why", source: "inferred" },
      tags: [{ name: "marsupials", source: "inferred" }],
    });
    const bBrowser = await addSecondUser(world);
    const before = ownedRows(world, A);
    const everything = allRows(world);

    const res = await undo(bBrowser, { id, editId });

    expect(res.status).toBe(404);
    expect(ownedRows(world, A)).toEqual(before);
    expect(allRows(world)).toEqual(everything);
    expect(before.link_edits).toHaveLength(1);
    expect(before.link_tags).toHaveLength(1);
    // A's own Undo of the same receipt is accepted, so B's 404 is down to whose link it is.
    expect((await undo(browser, { id, editId })).status).toBe(200);
  });

  it("POST /links/edit/undo of an AI receipt on a deleted link is a 404 and writes nothing", async () => {
    const { world, browser, id } = await edited();
    const { editId } = await updateLinkWithReceipt(linkDeps(world), A, id, {
      summary: "AI summary",
      tags: [{ name: "marsupials", source: "inferred" }],
    });
    await deleteLink(linkDeps(world), A, id);
    const before = allRows(world);

    expect((await undo(browser, { id, editId })).status).toBe(404);
    expect(allRows(world)).toEqual(before);
  });

  it.each([
    ["without an Origin", { origin: false }],
    ["with a foreign Origin", { headers: { origin: "https://evil.example" } }],
  ])("POST /links/edit refuses a request %s with 403, and every row stays", async (_, extra) => {
    const { world, browser, id } = await edited();
    const before = allRows(world);
    expect((await edit(browser, { id, title: "x" }, extra)).status).toBe(403);
    expect(allRows(world)).toEqual(before);
  });

  it.each([
    ["without an Origin", { origin: false }],
    ["with a foreign Origin", { headers: { origin: "https://evil.example" } }],
  ])(
    "POST /links/edit/undo refuses a request %s with 403, and every row stays",
    async (_, extra) => {
      const { world, browser, id } = await edited();
      const done = (await edit(browser, { id, title: "New" })).body as Answer;
      const before = allRows(world);
      const res = await browser.send("/links/edit/undo", {
        method: "POST",
        json: { id, editId: done.editId },
        ...extra,
      });
      expect(res.status).toBe(403);
      expect(allRows(world)).toEqual(before);
      // The same request with the right Origin is accepted, so the 403 is down to the Origin.
      expect((await undo(browser, { id, editId: done.editId })).status).toBe(200);
    },
  );

  it("POST /links/edit refuses a body over 2 MiB + 16 KiB with 413", async () => {
    const { world, browser, id } = await edited();
    const before = allRows(world);
    const over = Buffer.alloc(MAX_IMAGE_BYTES + AUTH_BODY_LIMIT + 1);
    expect((await edit(browser, { id, picture: file(over) })).status).toBe(413);
    expect(allRows(world)).toEqual(before);
  });

  it("POST /links/edit sends a signed-out caller to sign in before reading its body", async () => {
    const { world, id } = await edited();
    const before = allRows(world);
    const over = Buffer.alloc(MAX_IMAGE_BYTES + AUTH_BODY_LIMIT + 1);
    expect((await edit(world.agent(), { id, picture: file(over) })).status).toBe(302);
    const notAForm = await world
      .agent()
      .send("/links/edit", { method: "POST", json: { id, title: "x" } });
    expect(notAForm.status).toBe(302);
    expect(allRows(world)).toEqual(before);
  });

  it.each([
    ["a JSON body", (id: string) => ({ json: { id, title: "x" } })],
    ["a form without an id", () => ({ multipart: form({ title: "x" }) })],
    [
      "a picture that is neither a file nor page",
      (id: string) => ({ multipart: form({ id, picture: "elsewhere" }) }),
    ],
    ["a title sent as a file", (id: string) => ({ multipart: form({ id, title: file(MINE) }) })],
    ["an id that is not a number", () => ({ multipart: form({ id: "abc", title: "x" }) })],
    ["an id sent as a file", () => ({ multipart: form({ id: file(MINE), title: "x" }) })],
    [
      "a multipart type with a broken body",
      () => ({
        rawForm: "--x\r\nnot a part",
        headers: { "content-type": "multipart/form-data; boundary=x" },
      }),
    ],
  ])("POST /links/edit refuses %s with 400, and every row stays", async (_, body) => {
    const { world, browser, id } = await edited();
    const before = allRows(world);
    expect((await browser.send("/links/edit", { method: "POST", ...body(id) })).status).toBe(400);
    expect(allRows(world)).toEqual(before);
  });

  it("POST /links/edit/undo refuses a body without an editId with 400", async () => {
    const { browser, id } = await edited();
    expect((await undo(browser, { id })).status).toBe(400);
  });
});

describe("the owner's picture on every page", () => {
  it("search, All links, the space page and home show the owner's picture, and the cards carry its info", async () => {
    const { world, browser, id } = await edited();
    const deps = linkDeps(world);
    await updateLink(deps, A, id, { tags: [{ name: "Kitchen", source: "stated" }] });
    await deps.store.pinTag(A, "kitchen", { pinned: true, color: "clay" });
    await edit(browser, { id, picture: file(MINE) });
    for (const path of ["/search?q=", "/all", "/spaces?tag=Kitchen"]) {
      const { document } = parseHTML(String((await browser.send(path)).body));
      const card = document.querySelector(`li[data-id="${id}"]`);
      expect(card?.querySelector("img")?.getAttribute("src"), path).toBe(
        `/images/${id}?v=${v(MINE)}`,
      );
      expect(card?.getAttribute("data-own"), path).toBe("1");
      expect(card?.getAttribute("data-page-version"), path).toBe(v(PAGE));
      expect(card?.getAttribute("data-page-title"), path).toBe("Quokkas: a field guide");
    }
    expect(String((await browser.send("/")).body)).toContain(`/images/${id}?v=${v(MINE)}`);
  });
});

describe("the done pages", () => {
  it.each(["/all/done", "/spaces/done?tag=Kitchen"])(
    "%s reads the picture info and has the edit dialog, for a link with an owner picture",
    async (path) => {
      const { world, browser, id } = await edited();
      const deps = linkDeps(world);
      await updateLink(deps, A, id, { tags: [{ name: "Kitchen", source: "stated" }] });
      await edit(browser, { id, picture: file(MINE) });
      await deps.store.update(A, id, { state: "archived" });
      const info = vi.spyOn(SqliteImageStore.prototype, "pictureInfo");
      try {
        const { document } = parseHTML(String((await browser.send(path)).body));
        expect(document.querySelector(`li[data-id="${id}"]`)?.getAttribute("data-own")).toBe("1");
        expect(document.querySelector("#edit-link")).not.toBeNull();
        expect(info).toHaveBeenCalled();
      } finally {
        info.mockRestore();
      }
    },
  );
});
