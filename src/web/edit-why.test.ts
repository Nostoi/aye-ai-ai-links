import { describe, expect, it } from "vitest";
import { WHY_CONFLICT } from "../core/link-edit.js";
import type { Link } from "../core/types.js";
import { deleteLinkScript } from "./delete-link.js";
import { editDialog, editLinkScript } from "./edit-link.js";
import { homePage, type WorthCards } from "./home-page.js";
import { linkRow } from "./link-rows.js";
import { type Answer, type Post, runPage, stubDialog } from "./opened-test-kit.js";
import { page } from "./page.js";
import { searchPage } from "./pages.js";
import { CARD_FETCH } from "./tell-why.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const link = (over: Partial<Link> = {}): Link => ({
  id: "1",
  url: "https://ex.com/1",
  urlKey: "ex.com/1",
  title: "Link 1",
  summary: null,
  summarySource: null,
  why: null,
  tags: [],
  savedAt: NOW,
  savedBy: "t",
  lastOpenedAt: null,
  intent: "explore",
  intentSource: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});
const STATED = { text: "for my trip", source: "stated" } as const;
const GUESS = { text: "An article about trips", source: "inferred" } as const;

type Why = Link["why"];
const saved = (why: Why, summary: string | null = null, editId: string | null = "e1") => ({
  title: "Link 1",
  shown: "Link 1",
  url: "https://ex.com/1",
  initials: "L1",
  version: null,
  fit: null,
  picture: { own: false, pageVersion: null, pageFit: null },
  tags: [],
  space: null,
  lineSpace: null,
  intent: "explore",
  intentSource: null,
  why,
  summary,
  editId,
});

/** The Save answers `after`, its Undo the why the link had, as the server does. */
const answers =
  (before: Why, after: Why, summary: string | null = null) =>
  (sent: Post): Answer => ({
    status: 200,
    body: saved(sent.url === "/links/edit/undo" ? before : after, summary),
  });

const rows = (l: Link, ask = false) =>
  page(
    "Rows",
    `<h1>Rows</h1>
<p id="cards-error" role="alert"></p>
<ul id="cards">${linkRow(l, { space: null, lineSpace: null, ask })}</ul>
${editDialog()}
<script>
${CARD_FETCH}
${editLinkScript("cards", "cards-error")}
${deleteLinkScript("cards", "cards-error")}
</script>`,
    { menu: true, undo: true },
  );
const search = (l: Link) => searchPage({ query: "", links: [l], now: NOW });
const home = (l: Link, ...picks: Link[]) => {
  const worth: WorthCards = {
    links: [l, ...picks].map((link) => ({ link, reasons: [] })),
    images: new Map(),
    now: NOW,
    catalog: [],
    views: new Map(),
  };
  return homePage({ worth, shelf: "", spaces: "" });
};

type Page = ReturnType<typeof runPage>;
async function open(
  html: string,
  reply: (sent: Post) => Answer = () => ({ status: 200, body: saved(STATED) }),
  id = "1",
) {
  const p = runPage(html, reply);
  stubDialog(p);
  p.dispatch(p.$(`[data-id="${id}"] button[data-act=edit]`), "click");
  await p.settle();
  return p;
}
const field = (p: Page) => p.$("#edit-why") as HTMLTextAreaElement;
const type = (p: Page, text: string) => {
  field(p).value = text;
  p.dispatch(field(p), "input");
};
const submit = async (p: Page) => {
  p.dispatch(p.$("#edit-link form"), "submit");
  await p.settle();
};
const sent = (p: Page) => {
  const post = p.sent.find((s: Post) => s.url === "/links/edit");
  return post
    ? Object.fromEntries([...(post.body as FormData).entries()].map(([k, v]) => [k, String(v)]))
    : null;
};
const el = (p: Page, selector: string) => p.$(`[data-id="1"] ${selector}`) as HTMLElement;
const undoLast = async (p: Page) => {
  p.dispatch(p.$("#undo-bar button"), "click");
  await p.settle();
};

describe("the edit dialog's why box (#351)", () => {
  it("sits under Title and above Tags, labelled Why you saved it", async () => {
    const p = await open(rows(link({ why: STATED })));
    const form = p.$("#edit-link form");
    const order = [...form.querySelectorAll("#edit-title, #edit-why, .edit-tags")].map(
      (e) => e.id || e.className,
    );
    expect(order).toEqual(["edit-title", "edit-why", "edit-tags"]);
    expect(p.$('label[for="edit-why"]').textContent).toContain("Why you saved it");
  });

  it("opens on the card's why; a guess shows (a guess) and the hint, which go once the text changes", async () => {
    const p = await open(rows(link({ why: GUESS })));
    expect(field(p).value).toBe(GUESS.text);
    const mark = p.$("#edit-link [data-why-guess]") as HTMLElement;
    const hint = p.$("#edit-link [data-why-hint]") as HTMLElement;
    expect([mark.hidden, hint.hidden]).toEqual([false, false]);
    expect(mark.textContent).toBe("(a guess)");
    expect(hint.textContent).toBe("An AI guessed this. Change it to make it yours.");
    type(p, `${GUESS.text}!`);
    expect([mark.hidden, hint.hidden]).toEqual([true, true]);
    type(p, GUESS.text);
    expect([mark.hidden, hint.hidden]).toEqual([false, false]);
  });

  it("opens empty, with no guess mark, on a link with no why or a stated one", async () => {
    const none = await open(rows(link()));
    expect(field(none).value).toBe("");
    expect((none.$("#edit-link [data-why-guess]") as HTMLElement).hidden).toBe(true);
    const mine = await open(rows(link({ why: STATED })));
    expect(field(mine).value).toBe(STATED.text);
    expect((mine.$("#edit-link [data-why-hint]") as HTMLElement).hidden).toBe(true);
  });

  it("sends nothing for the why while the text is unchanged, a title-only Save included", async () => {
    const p = await open(rows(link({ why: GUESS })));
    (p.$("#edit-title") as HTMLInputElement).value = "Renamed";
    await submit(p);
    const body = sent(p);
    expect(body?.title).toBe("Renamed");
    expect(body?.why).toBeUndefined();
    expect(body?.whySeen).toBeUndefined();
  });

  it("sends why and whySeen once changed, and an emptied box sends an empty why", async () => {
    const guess = await open(rows(link({ why: GUESS })));
    type(guess, "  mine now ");
    await submit(guess);
    expect(sent(guess)?.why).toBe("  mine now ");
    expect(JSON.parse(sent(guess)?.whySeen ?? "")).toEqual(GUESS);
    const emptied = await open(rows(link({ why: STATED })));
    type(emptied, "");
    await submit(emptied);
    expect(sent(emptied)?.why).toBe("");
    expect(JSON.parse(sent(emptied)?.whySeen ?? "")).toEqual(STATED);
    const added = await open(rows(link()));
    type(added, "new");
    await submit(added);
    expect(sent(added)?.whySeen).toBe("null");
  });

  it("shows a 409's WHY_CONFLICT in the dialog and keeps it open", async () => {
    const p = await open(rows(link({ why: STATED })), () => ({
      status: 409,
      body: { code: "CONFLICT", message: WHY_CONFLICT },
    }));
    type(p, "other");
    await submit(p);
    expect(p.$("#edit-error").textContent).toBe(WHY_CONFLICT);
    expect((p.$("#edit-link") as HTMLDialogElement).open).toBe(true);
  });
});

describe("a card shows the answer's why in its own wording", () => {
  const edited = async (
    html: string,
    before: Why,
    answered: Why,
    summary: string | null = null,
  ) => {
    const p = await open(html, answers(before, answered, summary));
    type(p, "changed");
    await submit(p);
    return p;
  };

  it("a row says the words, or Why (a guess): for a guess, and hides when there is none", async () => {
    const p = await edited(rows(link({ why: STATED })), STATED, GUESS);
    expect(el(p, ".row-why").textContent).toBe(`Why (a guess): ${GUESS.text}`);
    expect(el(p, ".row-why").hidden).toBe(false);
    expect(el(p, ".row-why").dataset.cardWhy).toBe("text");
    await undoLast(p);
    expect(el(p, ".row-why").textContent).toBe(STATED.text);
    const none = await edited(rows(link({ why: STATED })), STATED, null);
    expect(el(none, ".row-why").hidden).toBe(true);
    expect(el(none, ".row-why").textContent).toBe("");
  });

  it("a row with no why gets one shown", async () => {
    const p = await edited(rows(link()), null, STATED);
    expect(el(p, ".row-why").textContent).toBe(STATED.text);
    expect(el(p, ".row-why").hidden).toBe(false);
  });

  it("a search result keeps Why: …, says Why (a guess): for a guess, and No why yet for none", async () => {
    const p = await edited(search(link({ why: GUESS })), GUESS, STATED);
    expect(el(p, '[data-card-why="line"]').textContent).toBe(`Why: ${STATED.text}`);
    await undoLast(p);
    expect(el(p, '[data-card-why="line"]').textContent).toBe(`Why (a guess): ${GUESS.text}`);
    const none = await edited(search(link({ why: STATED })), STATED, null);
    expect(el(none, '[data-card-why="line"]').textContent).toBe("No why yet");
  });

  it("a title-only Save on a search result keeps Why: …", async () => {
    const p = await open(search(link({ why: STATED })), () => ({
      status: 200,
      body: saved(STATED),
    }));
    (p.$("#edit-title") as HTMLInputElement).value = "Renamed";
    await submit(p);
    expect(el(p, '[data-card-why="line"]').textContent).toBe(`Why: ${STATED.text}`);
  });

  it("a row shows its summary when its why is removed, hides it when one is added, and Undo reverses both", async () => {
    const withSummary = (why: Why) => rows(link({ why, summary: "About trips" }));
    const removed = await edited(withSummary(STATED), STATED, null, "About trips");
    expect(el(removed, ".row-about").hidden).toBe(false);
    expect(el(removed, ".row-about").textContent).toBe("About trips");
    await undoLast(removed);
    expect(el(removed, ".row-about").hidden).toBe(true);
    const added = await edited(withSummary(null), null, STATED, "About trips");
    expect(el(added, ".row-about").hidden).toBe(true);
    await undoLast(added);
    expect(el(added, ".row-about").hidden).toBe(false);
  });
});

describe("Home's featured card", () => {
  const featuredWhy = (p: Page) => el(p, ".feature-why [data-card-why]");
  const ask = (p: Page) => el(p, ".feature-why .ask");
  const card = (p: Page) => p.$('[data-id="1"]') as HTMLElement;

  it("says You saved it for with a stated why, Why (a guess): for a guess", async () => {
    const p = await open(home(link({ why: GUESS })), answers(GUESS, STATED));
    type(p, "x");
    await submit(p);
    expect(featuredWhy(p).textContent).toBe(`You saved it for${STATED.text}`);
    expect(featuredWhy(p).querySelector(".why-label")?.textContent).toBe("You saved it for");
    await undoLast(p);
    expect(featuredWhy(p).textContent).toBe(`Why (a guess): ${GUESS.text}`);
    expect(featuredWhy(p).querySelector(".why-label")).toBeNull();
  });

  it("regains Tell me why and the amber outline when its why is removed; Undo reverses it", async () => {
    const p = await open(home(link({ why: STATED })), answers(STATED, null));
    expect(ask(p).hidden).toBe(true);
    type(p, "");
    await submit(p);
    expect([featuredWhy(p).hidden, ask(p).hidden]).toEqual([true, false]);
    expect(card(p).classList.contains("needs-you")).toBe(true);
    await undoLast(p);
    expect([featuredWhy(p).hidden, ask(p).hidden]).toEqual([false, true]);
    expect(card(p).classList.contains("needs-you")).toBe(false);
    expect(featuredWhy(p).textContent).toBe(`You saved it for${STATED.text}`);
  });

  it("loses Tell me why and the outline when a why is added; Undo reverses it", async () => {
    const p = await open(home(link()), answers(null, STATED));
    expect([featuredWhy(p).hidden, ask(p).hidden]).toEqual([true, false]);
    type(p, "for my trip");
    await submit(p);
    expect([featuredWhy(p).hidden, ask(p).hidden]).toEqual([false, true]);
    expect(card(p).classList.contains("needs-you")).toBe(false);
    await undoLast(p);
    expect([featuredWhy(p).hidden, ask(p).hidden]).toEqual([true, false]);
    expect(card(p).classList.contains("needs-you")).toBe(true);
  });

  it("after Tell me why, Edit link opens on that reason and its Save sends it as seen", async () => {
    const p = runPage(home(link()), (s) =>
      s.url === "/home/why" ? { status: 204 } : { status: 200, body: saved(null) },
    );
    stubDialog(p);
    const input = el(p, ".why-form input") as HTMLInputElement;
    input.value = "  to plan the trip ";
    p.dispatch(el(p, ".why-form"), "submit");
    await p.settle();
    p.dispatch(p.$('[data-id="1"] button[data-act=edit]'), "click");
    await p.settle();
    expect(field(p).value).toBe("to plan the trip");
    type(p, "to plan the Rome trip");
    await submit(p);
    expect(JSON.parse(sent(p)?.whySeen ?? "")).toEqual({
      text: "to plan the trip",
      source: "asked",
    });
  });
});

describe("Home's More to explore rows", () => {
  const pick = (why: Why) => home(link({ id: "1", why: STATED }), link({ id: "2", why }));
  const parts = (p: Page) => ({
    why: p.$('[data-id="2"] .also-why') as HTMLElement,
    line: p.$('[data-id="2"] [data-card-fallback]') as HTMLElement,
  });
  const run = async (before: Why, after: Why) => {
    const p = await open(pick(before), answers(before, after), "2");
    type(p, "changed");
    await submit(p);
    return p;
  };

  it("brings back the site-and-date line when the why is removed; Undo reverses it", async () => {
    const p = await run(STATED, null);
    expect([parts(p).why.hidden, parts(p).line.hidden]).toEqual([true, false]);
    await undoLast(p);
    expect([parts(p).why.hidden, parts(p).line.hidden]).toEqual([false, true]);
    expect(parts(p).why.textContent).toBe(STATED.text);
  });

  it("hides the line when a why is added; Undo reverses it", async () => {
    const p = await run(null, GUESS);
    expect([parts(p).why.hidden, parts(p).line.hidden]).toEqual([false, true]);
    expect(parts(p).why.textContent).toBe(`Why (a guess): ${GUESS.text}`);
    await undoLast(p);
    expect([parts(p).why.hidden, parts(p).line.hidden]).toEqual([true, false]);
  });
});
