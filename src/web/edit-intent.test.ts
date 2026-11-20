import { describe, expect, it } from "vitest";
import type { Link } from "../core/types.js";
import { cardLine } from "./card-line.js";
import { deleteLinkScript } from "./delete-link.js";
import { editData, editDialog, editLinkScript, editMenu } from "./edit-link.js";
import { linkTitle } from "./open-link.js";
import { type Answer, type Post, runPage, stubDialog } from "./opened-test-kit.js";
import { page } from "./page.js";
import { CARD_FETCH } from "./tell-why.js";

const link = (over: Partial<Link> = {}): Link => ({
  id: "1",
  url: "https://ex.com/1",
  urlKey: "ex.com/1",
  title: "Link 1",
  summary: null,
  summarySource: null,
  why: null,
  tags: [],
  savedAt: new Date("2026-10-17T12:00:00Z"),
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
const KEPT = { status: "kept", source: "stated", due: false } as const;

function cards(l: Link, keptTool: boolean) {
  return page(
    "Cards",
    `<p id="cards-error" role="alert"></p>
<ul id="cards"><li data-id="1" class="result"${editData(l, undefined, undefined)}>
<h3 data-card-title>${linkTitle(l)}</h3>
${cardLine(l, { space: null, intent: true })}${editMenu(l, keptTool ? { handy: KEPT } : {})}
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
const saved = (intent: string, intentSource: string | null) => ({
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
  intent,
  intentSource,
  editId: "e1",
});

type Page = ReturnType<typeof runPage>;
async function open(
  l: Link,
  { keptTool = false, reply }: { keptTool?: boolean; reply?: Answer } = {},
) {
  const p = runPage(
    cards(l, keptTool),
    () => reply ?? { status: 200, body: saved("keep", "stated") },
  );
  stubDialog(p);
  p.dispatch(p.$('[data-id="1"] button[data-act=edit]'), "click");
  await p.settle();
  return p;
}
const radio = (p: Page, value: string) =>
  p.$(`#edit-link input[name=edit-intent][value=${value}]`) as HTMLInputElement;
const choose = (p: Page, value: string) => {
  // The test DOM has no radio groups: a browser unchecks the other one itself.
  for (const other of ["explore", "keep"]) radio(p, other).checked = other === value;
  p.dispatch(radio(p, value), "change");
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
const KEEP = { intent: "keep" as const, intentSource: "stated" as const };

describe("the edit dialog's intent choice (#339)", () => {
  it("opens on what the card holds, and calls an inferred keep a guess until it is pressed", async () => {
    const p = await open(link({ intent: "keep", intentSource: "inferred" }));
    expect([radio(p, "explore").checked, radio(p, "keep").checked]).toEqual([false, true]);
    expect(p.$("#edit-link [data-intent-name]").textContent).toBe("To keep (a guess)");
    choose(p, "keep");
    expect(p.$("#edit-link [data-intent-name]").textContent).toBe("To keep");
  });

  it("sends no intent while the choice is untouched, a title-only Save included", async () => {
    const p = await open(link(KEEP));
    (p.$("#edit-title") as HTMLInputElement).value = "Renamed";
    await submit(p);
    const body = sent(p);
    expect(body?.title).toBe("Renamed");
    expect(body?.intent).toBeUndefined();
    expect(body?.intentSeen).toBeUndefined();
  });

  it("sends the choice with what the dialog opened with once pressed", async () => {
    const p = await open(link());
    choose(p, "keep");
    await submit(p);
    const body = sent(p);
    expect(body?.intent).toBe("keep");
    expect(JSON.parse(body?.intentSeen ?? "")).toEqual({ intent: "explore", source: null });
  });

  it("counts a press on the value it already had, and sends it with its source", async () => {
    const p = await open(link({ intent: "keep", intentSource: "inferred" }));
    choose(p, "keep");
    await submit(p);
    expect(sent(p)?.intent).toBe("keep");
    expect(JSON.parse(sent(p)?.intentSeen ?? "")).toEqual({ intent: "keep", source: "inferred" });
  });

  it("hides the choice on a kept tool and sends nothing for it", async () => {
    const p = await open(link(KEEP), { keptTool: true });
    expect((p.$("#edit-link .edit-intent") as HTMLElement).hidden).toBe(true);
    (p.$("#edit-title") as HTMLInputElement).value = "Renamed";
    await submit(p);
    expect(sent(p)?.intent).toBeUndefined();
  });

  it("shows the answer's intent on the card: its data, menu rows and grey line", async () => {
    const p = await open(link());
    choose(p, "keep");
    await submit(p);
    const card = p.$('[data-id="1"]') as HTMLElement;
    expect([card.dataset.intent, card.dataset.intentSource]).toEqual(["keep", "stated"]);
    const line = p.$('[data-id="1"] [data-intent-line]') as HTMLElement;
    expect([line.hidden, line.textContent]).toEqual([false, "To keep"]);
    expect((p.$("[data-id='1'] button[data-act=intent-keep]") as HTMLElement).hidden).toBe(true);
    expect((p.$("[data-id='1'] button[data-act=intent-explore]") as HTMLElement).hidden).toBe(
      false,
    );
  });
});
