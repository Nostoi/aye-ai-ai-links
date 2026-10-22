import { describe, expect, it } from "vitest";
import type { Link, LinkTag } from "../core/types.js";
import { cardLine } from "./card-line.js";
import { deleteLinkScript } from "./delete-link.js";
import { editData, editDialog, editLinkScript, editMenu } from "./edit-link.js";
import { linkTitle } from "./open-link.js";
import { type Answer, type Post, runPage, stubDialog } from "./opened-test-kit.js";
import { page } from "./page.js";
import { CARD_FETCH } from "./tell-why.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const tag = (name: string, source: LinkTag["source"] = "stated"): LinkTag => ({
  key: name.toLowerCase(),
  name,
  source,
  kind: "topic",
  kindSource: "inferred",
});
const link = (tags: LinkTag[]): Link => ({
  id: "1",
  url: "https://ex.com/1",
  urlKey: "ex.com/1",
  title: "Link 1",
  summary: null,
  why: null,
  tags,
  savedAt: NOW,
  savedBy: "t",
  lastOpenedAt: null,
  putAwayAt: null,
  tidyKeptAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
});

/** A list with one card (no space yet, its grey line holding the hidden slot) and the dialog. */
function cards(tags: LinkTag[], root = "") {
  const l = link(tags);
  return page(
    "Cards",
    `<p id="cards-error" role="alert"></p>
<ul id="cards"${root}><li data-id="1" class="result"${editData(l, undefined, undefined)}>
<h3 data-card-title>${linkTitle(l)}</h3>
${cardLine(l, { space: null })}${editMenu(l)}
</li></ul>
${editDialog()}
<script>
${CARD_FETCH}
${editLinkScript("cards", "cards-error")}
${deleteLinkScript("cards", "cards-error")}
</script>`,
    { menu: true, undo: true },
  );
}

const NAMES = [
  "Kitchen",
  "Garden",
  "Quokkas",
  "Quokka burrows",
  "Baking",
  "Bread",
  "Brunch",
  "Brew",
];
const saved = (over: Record<string, unknown> = {}) => ({
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
  editId: "e1",
  ...over,
});

type Page = ReturnType<typeof runPage>;
/** Opens the dialog on the card, with `/tags/names` answering `names`. */
async function open(
  tags: LinkTag[],
  {
    root = "",
    names = NAMES,
    reply = () => ({ status: 200, body: saved() }),
    tagNames = () => ({ status: 200, body: { names } }),
  }: {
    root?: string;
    names?: string[];
    reply?: (sent: Post) => Answer;
    tagNames?: (sent: Post) => Answer;
  } = {},
) {
  const p = runPage(cards(tags, root), reply, tagNames);
  stubDialog(p);
  p.dispatch(p.$('[data-id="1"] button[data-act=edit]'), "click");
  await p.settle();
  return p;
}
const chips = (p: Page) =>
  [...p.document.querySelectorAll("#edit-link .edit-tag")].map((c) => c.textContent?.trim());
const type = (p: Page, text: string) => {
  const field = p.$("#edit-tag-input") as HTMLInputElement;
  field.value = text;
  p.dispatch(field, "input");
};
const suggestions = (p: Page) =>
  [...p.document.querySelectorAll("#edit-link .edit-suggest-item")].map((b) => b.textContent);
const press = (p: Page, key: string) => p.dispatch(p.$("#edit-tag-input"), "keydown", { key });
const submit = async (p: Page) => {
  p.dispatch(p.$("#edit-link form"), "submit");
  await p.settle();
};
const posts = (p: Page) => p.sent.filter((s) => s.url === "/links/edit");
const fields = (post: Post | undefined) => {
  if (!post) throw new Error("no request was sent");
  return Object.fromEntries([...(post.body as FormData).entries()].map(([k, v]) => [k, String(v)]));
};

describe("the edit dialog's tags", () => {
  it("shows one chip per tag in order, a guess marked, each with a Remove button", async () => {
    const p = await open([tag("Kitchen"), tag("Guess", "inferred")]);
    expect(chips(p)).toEqual(["Kitchen", "Guess (a guess)"]);
    const removes = [...p.document.querySelectorAll("#edit-link .edit-tag-remove")];
    expect(removes.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Remove Kitchen",
      "Remove Guess",
    ]);
    expect(removes.every((b) => b.getAttribute("type") === "button")).toBe(true);
  });

  it("labels the add field 'Add a tag', with autocomplete off", async () => {
    const p = await open([]);
    const field = p.$("#edit-tag-input");
    expect(p.$('label[for="edit-tag-input"]').textContent).toBe("Add a tag");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(p.$("#edit-link .edit-tags legend").textContent).toBe("Tags");
  });

  it("keeps a hostile tag name as text", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const p = await open([tag(hostile)]);
    expect(p.document.querySelector("#edit-link .edit-tags img")).toBeNull();
    expect(chips(p)).toEqual([hostile]);
  });

  it("removes a tag when its button is pressed", async () => {
    const p = await open([tag("Kitchen"), tag("Garden")]);
    p.dispatch(p.$('#edit-link .edit-tag-remove[aria-label="Remove Kitchen"]'), "click");
    expect(chips(p)).toEqual(["Garden"]);
  });

  it("fetches the owner's tag names once per open", async () => {
    const p = await open([]);
    expect(p.names).toHaveLength(1);
  });

  it("suggests up to 6 catalog names that contain the text, prefix matches first, not those on the link", async () => {
    const p = await open([tag("Quokkas")]);
    expect(suggestions(p)).toEqual([]);
    expect(p.$("#edit-link .edit-suggest").hidden).toBe(true);
    type(p, "br");
    expect(suggestions(p)).toEqual(["Bread", "Brunch", "Brew"]);
    type(p, "Ok");
    // "Quokkas" is on the link; "Quokka burrows" contains the text.
    expect(suggestions(p)).toEqual(["Quokka burrows"]);
    type(p, "");
    expect(suggestions(p)).toEqual([]);
    expect(p.$("#edit-link .edit-suggest").hidden).toBe(true);
  });

  it("shows at most 6 suggestions, the names that start with the text before the rest", async () => {
    const names = ["Zebra", "Apple", "Apricot", "Banana", "Avocado", "Mango", "Papaya", "Grape"];
    const p = await open([], { names });
    type(p, "a");
    expect(suggestions(p)).toEqual(["Apple", "Apricot", "Avocado", "Zebra", "Banana", "Mango"]);
  });

  it("adds a clicked suggestion and clears the field", async () => {
    const p = await open([tag("Kitchen")]);
    type(p, "gard");
    p.dispatch(p.$("#edit-link .edit-suggest-item"), "click");
    expect(chips(p)).toEqual(["Kitchen", "Garden"]);
    expect((p.$("#edit-tag-input") as HTMLInputElement).value).toBe("");
    expect(suggestions(p)).toEqual([]);
  });

  it("adds the typed name on Enter, without submitting the form", async () => {
    const p = await open([tag("Kitchen")]);
    type(p, "  New   idea ");
    const enter = press(p, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(chips(p)).toEqual(["Kitchen", "New idea"]);
    expect(p.sent).toEqual([]);
    press(p, "Enter");
    expect(chips(p)).toHaveLength(2);
  });

  it("does not add a name whose key is already on the link", async () => {
    const p = await open([tag("Kitchen")]);
    type(p, "  kitchen ");
    press(p, "Enter");
    expect(chips(p)).toEqual(["Kitchen"]);
    expect((p.$("#edit-tag-input") as HTMLInputElement).value).toBe("");
  });

  it("works with no suggestions when the names fetch fails", async () => {
    const p = await open([tag("Kitchen")], { tagNames: () => ({ status: 500 }) });
    type(p, "ki");
    expect(suggestions(p)).toEqual([]);
    type(p, "Fresh");
    press(p, "Enter");
    expect(chips(p)).toEqual(["Kitchen", "Fresh"]);
  });

  it("ignores the names of an earlier open", async () => {
    let release: (v?: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const p = runPage(
      cards([tag("Kitchen")]),
      () => ({ status: 200, body: saved() }),
      () => {
        calls += 1;
        return calls === 1
          ? { status: 200, body: { names: ["Stale name"] }, wait: slow }
          : { status: 200, body: { names: ["Fresh name"] } };
      },
    );
    const dialog = stubDialog(p);
    p.dispatch(p.$('[data-id="1"] button[data-act=edit]'), "click");
    dialog.close();
    p.dispatch(p.$('[data-id="1"] button[data-act=edit]'), "click");
    await p.settle();
    release();
    await p.settle();
    type(p, "name");
    expect(suggestions(p)).toEqual(["Fresh name"]);
  });
});

describe("Save with tags", () => {
  const root = ' data-within="kitchen" data-own="1"';

  it("sends the final names in order and the tags the dialog opened with, only when the order of keys changed", async () => {
    const p = await open([tag("Kitchen"), tag("Guess", "inferred")], { root });
    p.dispatch(p.$('#edit-link .edit-tag-remove[aria-label="Remove Kitchen"]'), "click");
    type(p, "Fresh");
    press(p, "Enter");
    await submit(p);
    const sent = fields(posts(p)[0]);
    expect(JSON.parse(sent.tags ?? "")).toEqual(["Guess", "Fresh"]);
    expect(JSON.parse(sent.seen ?? "")).toEqual([
      { key: "kitchen", source: "stated" },
      { key: "guess", source: "inferred" },
    ]);
    expect(sent.within).toBe("kitchen");
    expect(sent.own).toBe("1");
    expect(sent.id).toBe("1");
    expect(sent.title).toBeUndefined();
  });

  it("adds the text left in the field first", async () => {
    const p = await open([tag("Kitchen")]);
    type(p, "Left over");
    await submit(p);
    expect(JSON.parse(fields(posts(p)[0]).tags ?? "")).toEqual(["Kitchen", "Left over"]);
  });

  it("sends no request when the tags were removed and added back in their opening order, a guess still a guess", async () => {
    const p = await open([tag("Kitchen"), tag("Guess", "inferred")]);
    p.dispatch(p.$('#edit-link .edit-tag-remove[aria-label="Remove Kitchen"]'), "click");
    p.dispatch(p.$('#edit-link .edit-tag-remove[aria-label="Remove Guess"]'), "click");
    for (const name of ["kitchen", "GUESS"]) {
      type(p, name);
      press(p, "Enter");
    }
    expect(chips(p)).toEqual(["Kitchen", "Guess (a guess)"]);
    await submit(p);
    expect(posts(p)).toEqual([]);
  });

  it("sends the names when a tag was removed and added back in another place", async () => {
    const p = await open([tag("Kitchen"), tag("Guess", "inferred")]);
    p.dispatch(p.$('#edit-link .edit-tag-remove[aria-label="Remove Kitchen"]'), "click");
    type(p, "Kitchen");
    press(p, "Enter");
    await submit(p);
    expect(JSON.parse(fields(posts(p)[0]).tags ?? "")).toEqual(["Guess", "Kitchen"]);
  });

  it("after a 409 the card still holds the tags it opened with, so the dialog sends the same seen again: only a reload recovers", async () => {
    const conflict = { code: "conflict", message: "This link's tags changed." };
    const p = await open([tag("Kitchen")], { reply: () => ({ status: 409, body: conflict }) });
    type(p, "One");
    await submit(p);
    expect(p.$("#edit-error").textContent).toBe(conflict.message);
    p.dispatch(p.$("#edit-link"), "close");
    p.dispatch(p.$('[data-id="1"] button[data-act=edit]'), "click");
    await p.settle();
    type(p, "Two");
    await submit(p);
    const [first, second] = posts(p).map((post) => fields(post).seen);
    expect(second).toBe(first);
    expect(JSON.parse(second ?? "")).toEqual([{ key: "kitchen", source: "stated" }]);
  });

  it("sends only the title when the tags are as they were", async () => {
    const p = await open([tag("Kitchen")]);
    (p.$("#edit-title") as HTMLInputElement).value = "Renamed";
    await submit(p);
    const sent = fields(posts(p)[0]);
    expect(sent.title).toBe("Renamed");
    expect(sent.tags).toBeUndefined();
    expect(sent.seen).toBeUndefined();
  });

  it("sends neither within nor own from a list that has none", async () => {
    const p = await open([tag("Kitchen")]);
    type(p, "More");
    press(p, "Enter");
    await submit(p);
    const sent = fields(posts(p)[0]);
    expect(sent.within).toBeUndefined();
    expect(sent.own).toBeUndefined();
  });

  it("turns the tag controls off while the Save is out", async () => {
    let release: (v?: unknown) => void = () => {};
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    const p = await open([tag("Kitchen")], {
      reply: () => ({ status: 200, body: saved(), wait }),
    });
    type(p, "More");
    p.dispatch(p.$("#edit-link form"), "submit");
    await p.settle();
    expect((p.$("#edit-tag-input") as HTMLInputElement).disabled).toBe(true);
    const remove = p.$("#edit-link .edit-tag-remove") as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    release();
    await p.settle();
  });
});

describe("the card after a Save or Undo", () => {
  const root = ' data-within="kitchen" data-own="1"';
  const card = (p: Page) => p.$('[data-id="1"]');
  const slot = (p: Page) => p.$('[data-id="1"] .line-space');

  it("takes the answer's tags, space class and grey-line space; Undo does the same and sends within and own", async () => {
    const answers = [
      saved({
        tags: [{ key: "kitchen", name: "Kitchen", source: "stated" }],
        space: { color: "clay" },
        lineSpace: { name: "Kitchen" },
        editId: "e1",
      }),
      saved({ tags: [], space: null, lineSpace: null, editId: null }),
    ];
    const p = await open([], { root, reply: () => ({ status: 200, body: answers.shift() }) });
    expect(slot(p).hasAttribute("hidden")).toBe(true);
    type(p, "Kitchen");
    await submit(p);
    expect(JSON.parse(card(p).dataset.tags ?? "")).toEqual([
      { key: "kitchen", name: "Kitchen", source: "stated" },
    ]);
    expect(card(p).className).toBe("result space-clay");
    expect(slot(p).hasAttribute("hidden")).toBe(false);
    expect(p.$('[data-id="1"] [data-space-name]').textContent).toBe("Kitchen");
    p.dispatch(p.$("#undo-bar button"), "click");
    await p.settle();
    const undoPost = p.sent.find((s) => s.url === "/links/edit/undo");
    expect(undoPost?.body).toEqual({ id: "1", editId: "e1", within: "kitchen", own: "1" });
    expect(card(p).className).toBe("result");
    expect(card(p).dataset.tags).toBe("[]");
    expect(slot(p).hasAttribute("hidden")).toBe(true);
    expect(p.$('[data-id="1"] [data-space-name]').textContent).toBe("");
  });

  it("swaps one space class for another and keeps the name hidden when the line leaves it out", async () => {
    const p = await open([tag("Garden")], {
      root,
      reply: () => ({
        status: 200,
        body: saved({ space: { color: "teal" }, lineSpace: null }),
      }),
    });
    card(p).classList.add("space-clay");
    type(p, "Other");
    await submit(p);
    expect(card(p).className).toBe("result space-teal");
    expect(slot(p).hasAttribute("hidden")).toBe(true);
  });

  it("reads the new tags the next time the dialog opens", async () => {
    const p = await open([], {
      reply: () => ({
        status: 200,
        body: saved({ tags: [{ key: "fresh", name: "Fresh", source: "stated" }] }),
      }),
    });
    type(p, "Fresh");
    await submit(p);
    p.dispatch(p.$('[data-id="1"] button[data-act=edit]'), "click");
    await p.settle();
    expect(chips(p)).toEqual(["Fresh"]);
  });
});
