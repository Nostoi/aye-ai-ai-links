import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addSecondUser, oauthWorld, SECOND_USER } from "../auth/oauth-test-kit.js";
import type { GoneView } from "../core/link-check.js";
import { saveLink } from "../core/links.js";
import { type CopyInfo, copyLimits } from "../core/saved-copy.js";
import type { Link, Tag } from "../core/types.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { allPage } from "./all-page.js";
import { editMenu } from "./edit-link.js";
import { goneLine } from "./gone-line.js";
import { searchPage } from "./pages.js";
import { spacePage } from "./space-page.js";

const NOW = new Date("2026-10-14T12:00:00Z");
const INFO: CopyInfo = { madeAt: new Date("2026-10-01T00:00:00Z") };
const GONE: GoneView = {
  since: new Date("2026-10-10T00:00:00Z"),
  checkedAt: new Date("2026-10-13T00:00:00Z"),
};
const TAG: Tag = {
  key: "home",
  name: "Home",
  kind: "topic",
  kindSource: "stated",
  color: "teal",
  pinned: true,
  description: null,
  projectStatus: null,
};
const link = (id: string, over: Partial<Link> = {}): Link => ({
  id,
  url: `https://ex.com/${id}`,
  urlKey: `ex.com/${id}`,
  title: `Link ${id}`,
  summary: null,
  why: { text: `because ${id}`, source: "stated" },
  tags: [],
  savedAt: new Date("2026-10-01T00:00:00Z"),
  savedBy: "t",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});
const dom = (html: string) => parseHTML(html).document;
/** A card's links to its saved copy, wherever they are on the card. */
const rows = (html: string, id: string) =>
  [...dom(html).querySelectorAll(`[data-id="${id}"] a[href$="/copy"]`)].map((a) => [
    a.getAttribute("href"),
    a.getAttribute("data-act"),
    a.textContent,
  ]);
const goneLinks = (html: string, id: string) =>
  [...dom(html).querySelectorAll(`[data-id="${id}"] .small-actions a`)].map((a) =>
    a.getAttribute("href"),
  );
const ROW = (id: string) => [[`/links/${id}/copy`, "read-copy", "Saved copy"]];
const lineLink = (html: string, id: string) =>
  dom(html).querySelector(`[data-id="${id}"] .card-line a.saved-copy`);

describe("the card menu", () => {
  it("never links the saved copy: the card's grey line does", () => {
    const d = dom(editMenu(link("7"), { copy: INFO }));
    expect(d.querySelector("a")).toBeNull();
    expect(
      [...d.querySelectorAll(".card-menu-list > :not([hidden], hr)")].map((e) => e.textContent),
    ).toEqual([
      "I'm done with it",
      "Keep handy",
      "Edit title and picture…",
      "Remove saved copy",
      "Delete link",
    ]);
  });
});

describe("goneLine", () => {
  it("never links the saved copy: the card's grey line does", () => {
    expect(dom(goneLine(link("1"), GONE)).querySelector("a")).toBeNull();
    expect(dom(goneLine(link("1", { state: "archived" }), GONE)).querySelector("a")).toBeNull();
    expect(goneLine(link("1"), null)).toBe("");
  });
});

describe("the page builders", () => {
  const copies = new Map([["1", INFO]]);
  const gone = new Map([
    ["1", GONE],
    ["2", GONE],
  ]);
  const links = [link("1"), link("2")];
  const all = (over: object = {}) =>
    allPage({
      order: "newest",
      links,
      older: null,
      catalog: [],
      images: new Map(),
      handy: new Map(),
      now: NOW,
      done: false,
      ...over,
    });
  const space = (over: object = {}) =>
    spacePage({
      tag: TAG,
      catalog: [TAG],
      links,
      older: null,
      images: new Map(),
      handy: new Map(),
      now: NOW,
      done: false,
      ...over,
    });
  const search = (over: object = {}) => searchPage({ query: "", links, now: NOW, ...over });
  const builders: [string, (o?: object) => string][] = [
    ["search", search],
    ["all links", all],
    ["a space", space],
  ];

  it.each(builders)("%s: only cards in `copies` link their copy, on the grey line", (_, build) => {
    const html = build({ copies });
    expect(rows(html, "1")).toEqual(ROW("1"));
    expect(lineLink(html, "1")).not.toBeNull();
    expect(rows(html, "2")).toEqual([]);
    expect(rows(build(), "1")).toEqual([]);
  });

  it.each(builders)("%s: a gone card with a copy links it once, on the grey line", (_, build) => {
    const html = build({ copies, gone });
    expect(rows(html, "1")).toEqual(ROW("1"));
    expect(lineLink(html, "1")).not.toBeNull();
    expect(goneLinks(html, "1")).toEqual([]);
    expect(rows(html, "2")).toEqual([]);
  });

  it.each([
    ["all links", all],
    ["a space", space],
  ])("%s done page: the grey line links the copy, and the menu can remove it", (_, build) => {
    const html = build({ links: [link("1", { state: "archived" })], copies, gone, done: true });
    expect(dom(html).querySelector(".card-menu [data-act=remove-copy]")).not.toBeNull();
    expect(rows(html, "1")).toEqual(ROW("1"));
    expect(lineLink(html, "1")).not.toBeNull();
  });
});

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const DAY = 86_400_000;
const DRAFT = { markdown: "Some words", imageUrls: [], nonce: "0123456789abcdef0123456789abcdef" };

/** A world on a temp folder, a signed-in second owner, and ways to seed links and copies. */
async function world() {
  const dir = mkdtempSync(join(tmpdir(), "aye-copy-row-"));
  dirs.push(dir);
  const w = await oauthWorld({ savedCopyDir: dir });
  const other = await addSecondUser(w);
  const deps = createDeps(w.links, new FakeEmbedder(DIMS));
  const save = async (
    owner: string,
    title: string,
    { copy = false, tags = [] as { name: string; source: "stated" }[] } = {},
  ) => {
    const { link: l } = await saveLink(deps, owner, {
      url: `https://${owner}.example/${title.replace(/\W/g, "")}`,
      title,
      savedBy: "seed",
      tags,
    });
    if (copy) {
      await w.savedCopies.saveCopy(owner, l.id, DRAFT, copyLimits(1_000_000), new Date());
      expect((await w.savedCopies.copyInfo(owner, [l.id])).has(l.id)).toBe(true);
    }
    return l.id;
  };
  const flag = (id: string) =>
    deps.checks.updateCheckIf("owner", id, null, {
      checkedAt: new Date(Date.now() - DAY),
      result: "dead",
      detail: "http:404",
      firstDeadAt: new Date(Date.now() - 20 * DAY),
      flaggedAt: new Date(Date.now() - 10 * DAY),
      stillWorksAt: null,
    });
  const browser = w.agent();
  await browser.signIn();
  const get = async (path: string) => String((await browser.send(path)).body);
  return { w, deps, save, flag, get, other };
}

describe("the pages' routes", () => {
  it("search: only the link with an ok copy has the row, from one copyInfo read", async () => {
    const { w, save, get } = await world();
    const withCopy = await save("owner", "Quokka with copy", { copy: true });
    const without = await save("owner", "Quokka without");
    const spy = vi.spyOn(w.savedCopies, "copyInfo");
    const html = await get("/search?q=Quokka");
    expect(rows(html, withCopy)).toEqual(ROW(withCopy));
    expect(rows(html, without)).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("search: another owner never gets the row for A's links", async () => {
    const { save, other } = await world();
    await save("owner", "Quokka of A", { copy: true });
    const mine = await save(SECOND_USER.id, "Quokka of B");
    const html = String((await other.send("/search?q=Quokka")).body);
    expect(html).not.toContain("Quokka of A");
    expect(dom(html).querySelector(".saved-copy")).toBeNull();
    expect(rows(html, mine)).toEqual([]);
  });

  it("all links: the row shows on /all, from one read", async () => {
    const { w, save, get } = await world();
    const id = await save("owner", "Old with copy", { copy: true });
    const spy = vi.spyOn(w.savedCopies, "copyInfo");
    expect(rows(await get("/all"), id)).toEqual(ROW(id));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("all links: a ?before= page carries rows too", async () => {
    const { save, get } = await world();
    const oldest = await save("owner", "Oldest with copy", { copy: true });
    for (let i = 0; i < 24; i++) await save("owner", `Filler ${i}`);
    const older = dom(await get("/all"))
      .getElementById("older")
      ?.getAttribute("href");
    expect(older).toContain("before=");
    const html = await get(older as string);
    expect(rows(html, oldest)).toEqual(ROW(oldest));
  });

  it("all links: a gone archived link links its copy once, and has the menu, on /all/done", async () => {
    const { deps, save, flag, get } = await world();
    const id = await save("owner", "Gone and done", { copy: true });
    await flag(id);
    await deps.store.update("owner", id, { state: "archived" });
    const html = await get("/all/done");
    expect(rows(html, id)).toEqual(ROW(id));
    expect(dom(html).querySelector(`[data-id="${id}"] [data-gone]`)).not.toBeNull();
    expect(dom(html).querySelector(".card-menu")).not.toBeNull();
  });

  it("spaces: the row shows on /spaces?tag=, from one read", async () => {
    const { w, save, get } = await world();
    const id = await save("owner", "Tagged", {
      copy: true,
      tags: [{ name: "Kitchen", source: "stated" }],
    });
    const spy = vi.spyOn(w.savedCopies, "copyInfo");
    expect(rows(await get("/spaces?tag=Kitchen"), id)).toEqual(ROW(id));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("home: the gone pick with a copy shows Read the saved copy", async () => {
    const { save, flag, get } = await world();
    const id = await save("owner", "Old page", { copy: true });
    await flag(id);
    const reads = dom(await get("/")).querySelectorAll(`#worth-cards [data-id="${id}"] .gone-copy`);
    expect([...reads].map((a) => a.getAttribute("href"))).toEqual([`/links/${id}/copy`]);
  });

  it("home: reads copyInfo once, for the cards it shows, and links a pick's copy on its grey line", async () => {
    const { w, save, get } = await world();
    const id = await save("owner", "Plain", { copy: true });
    const spy = vi.spyOn(w.savedCopies, "copyInfo");
    const html = await get("/");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toEqual([id]);
    expect(lineLink(html, id)?.getAttribute("href")).toBe(`/links/${id}/copy`);
  });
});
