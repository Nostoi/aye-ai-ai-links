import { describe, expect, it } from "vitest";
import type { Link, Tag } from "../core/types.js";
import { allPage } from "./all-page.js";
import { connectionsPage } from "./connections-page.js";
import { copyNotFoundPage, copyPage } from "./copy-page.js";
import { homePage } from "./home-page.js";
import { consentExpiredPage, consentPage, loginPage, oauthErrorPage, searchPage } from "./pages.js";
import { profilePage } from "./profile-page.js";
import { saveForm } from "./save-form.js";
import { olderInvalidPage } from "./show-older.js";
import { spaceMissingPage, spacePage } from "./space-page.js";
import { tagsPage } from "./tags-page.js";

/**
 * The snapshots are made with no AI set up. Each page, and each variant that changes its markup,
 * is stored as one. They change only when a PR changes a page on purpose (regenerate them with
 * `vitest -u` and read the diff); the Ask AI panel (#159) must still add nothing when it is off.
 */

const NOW = new Date("2026-10-14T12:00:00Z");

const tag = (over: Partial<Tag> & { key: string }): Tag => ({
  name: over.key,
  kind: "topic",
  kindSource: "stated",
  color: null,
  pinned: false,
  description: null,
  projectStatus: null,
  ...over,
});
const KITCHEN = tag({ key: "kitchen", name: "Kitchen", color: "clay", pinned: true });
const BAKING = tag({ key: "baking", name: "Baking" });

const link = (id: string, over: Partial<Link> = {}): Link => ({
  id,
  url: `https://example.com/${id}`,
  urlKey: `example.com/${id}`,
  title: `Title ${id}`,
  summary: "A summary",
  why: { text: "to compare", source: "stated" },
  tags: [
    {
      key: "kitchen",
      name: "Kitchen",
      source: "stated",
      kind: "topic",
      kindSource: "stated",
    },
  ],
  savedAt: new Date("2026-03-12T10:00:00Z"),
  savedBy: "claude",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});
const ONE = [link("1")];
const NO_WHY = [link("2", { why: null })];

const list = {
  order: "newest" as const,
  older: null,
  catalog: [KITCHEN],
  images: new Map(),
  handy: new Map(),
  now: NOW,
  done: false,
};
const spaceInput = {
  tag: KITCHEN,
  catalog: [KITCHEN],
  older: null,
  images: new Map(),
  handy: new Map(),
  now: NOW,
  done: false,
};
const worth = (links: { link: Link; reasons: [] }[]) => ({
  links,
  images: new Map(),
  now: NOW,
  catalog: [KITCHEN],
  gone: null,
  goneCopy: null,
});
const IDLE = { state: "idle" } as const;
const connections = (over: Partial<Parameters<typeof connectionsPage>[0]> = {}) =>
  connectionsPage({
    connections: [],
    keys: [],
    now: NOW,
    bookmarklet: "javascript:void(0)",
    exportView: IDLE,
    ...over,
  });
const copyView = (copy: Parameters<typeof copyPage>[0]["copy"]) =>
  copyPage({ link: link("3"), madeAt: NOW, copy }, NOW);

const pages: Record<string, () => string> = {
  "home-empty": () => homePage({ worth: worth([]), shelf: "", spaces: "" }),
  "home-with-card": () =>
    homePage({
      worth: worth([{ link: link("1"), reasons: [] }]),
      shelf: "<section>shelf</section>",
      spaces: "<section>spaces</section>",
    }),
  "all-empty": () => allPage({ ...list, links: [] }),
  "all-with-links": () => allPage({ ...list, links: [...ONE, ...NO_WHY], older: "r1" }),
  "all-done": () => allPage({ ...list, links: [link("4", { state: "archived" })], done: true }),
  "space-empty": () => spacePage({ ...spaceInput, links: [] }),
  "space-with-links": () => spacePage({ ...spaceInput, links: [...ONE, ...NO_WHY], older: "r1" }),
  "space-done": () => spacePage({ ...spaceInput, links: [], done: true }),
  "space-missing": () => spaceMissingPage(),
  "older-invalid": () => olderInvalidPage('Open it again from the <a href="/">home page</a>.'),
  "search-empty": () => searchPage({ query: "", links: [], now: NOW }),
  "search-with-links": () =>
    searchPage({ query: "kitchen", links: [...ONE, ...NO_WHY], now: NOW, catalog: [KITCHEN] }),
  "profile-empty": () => profilePage({ notes: [], focus: [], now: NOW }),
  "profile-with-notes": () =>
    profilePage({
      notes: [
        {
          id: "n1",
          text: "Likes tea",
          source: "stated",
          writtenBy: "Claude",
          updatedAt: NOW,
        },
      ],
      focus: [
        {
          id: "f1",
          text: "the garden plan",
          source: "inferred",
          writtenBy: "Claude",
          createdAt: NOW,
        },
      ],
      now: NOW,
    }),
  "tags-empty": () => tagsPage({ tags: [] }),
  "tags-with-tags": () => tagsPage({ tags: [KITCHEN, BAKING] }),
  "connections-empty": () => connections(),
  "connections-with-rows": () =>
    connections({
      connections: [{ clientId: "c", name: "Claude", connectedAt: NOW }],
      keys: [{ id: 7, name: "codex", createdAt: NOW, revokedAt: null }],
    }),
  "save-bare": () => saveForm({ url: "", title: "", long: false }),
  "save-filled": () =>
    saveForm({ url: "https://example.com/a?b=1", title: "A <b>title</b>", long: false }),
  "save-long": () => saveForm({ url: "", title: "", long: true }),
  "copy-ok": () =>
    copyView({
      markdown: "# Hello\n\nA paragraph.",
      madeAt: NOW,
      finished: true,
      nonce: null,
      images: new Map(),
    }),
  "copy-missing": () => copyView("missing"),
  "copy-unreadable": () => copyView("unreadable"),
  "copy-not-found": () => copyNotFoundPage(),
  login: () => loginPage({ next: "/all" }),
  consent: () => consentPage({ clientName: "Claude", redirectHost: "claude.ai" }),
  "consent-expired": () => consentExpiredPage(),
  "oauth-error": () => oauthErrorPage("It did not work."),
};

describe("with no AI set up", () => {
  it("no page carries any Ask AI markup, style or script", () => {
    for (const [name, render] of Object.entries(pages)) {
      const html = render();
      for (const mark of ["ask-open", "ask-panel", "aye-ask", "askPanel"]) {
        expect(html, `${name}: ${mark}`).not.toContain(mark);
      }
    }
  });

  for (const [name, render] of Object.entries(pages)) {
    it(`${name} is byte for byte as it was before the Ask AI panel`, async () => {
      await expect(render()).toMatchFileSnapshot(`__ask_off__/${name}.html`);
    });
  }
});
