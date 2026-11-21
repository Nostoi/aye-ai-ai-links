import { describe, expect, it } from "vitest";
import { allRows } from "../auth/oauth-test-kit.js";
import { WHY_CONFLICT } from "../core/link-edit.js";
import { type Answer, edit, edited, undo } from "./edit-routes-kit.js";

type WhyAnswer = Answer & { why: { text: string; source: string } | null; summary: string | null };
const NONE = JSON.stringify(null);
const seenOf = (text: string, source: string) => JSON.stringify({ text, source });
const whyOf = (world: Awaited<ReturnType<typeof edited>>["world"], id: string) =>
  world.links.prepare("SELECT why_text, why_source FROM links WHERE id = ?").get(Number(id));
const seed = (
  world: Awaited<ReturnType<typeof edited>>["world"],
  id: string,
  text: string | null,
  source: string | null,
) =>
  world.links
    .prepare("UPDATE links SET why_text = ?, why_source = ? WHERE id = ?")
    .run(text, source, Number(id));

describe("why in POST /links/edit and its Undo", () => {
  it("writes the why as stated, answers it on the card, and Undo gives the old one back", async () => {
    const { world, browser, id } = await edited();
    seed(world, id, "a guess", "inferred");
    const res = await edit(browser, {
      id,
      why: "  for my trip ",
      whySeen: seenOf("a guess", "inferred"),
    });
    expect(res.status).toBe(200);
    const body = res.body as WhyAnswer;
    expect(body.why).toEqual({ text: "for my trip", source: "stated" });
    expect(body.editId).toEqual(expect.any(String));
    expect(whyOf(world, id)).toEqual({ why_text: "for my trip", why_source: "stated" });
    const back = await undo(browser, { id, editId: body.editId });
    expect(back.status).toBe(200);
    expect((back.body as WhyAnswer).why).toEqual({ text: "a guess", source: "inferred" });
    expect(whyOf(world, id)).toEqual({ why_text: "a guess", why_source: "inferred" });
  });

  it("an empty why removes it, and the card answers none", async () => {
    const { world, browser, id } = await edited();
    seed(world, id, "mine", "stated");
    const res = await edit(browser, { id, why: "", whySeen: seenOf("mine", "stated") });
    expect(res.status).toBe(200);
    expect((res.body as WhyAnswer).why).toBeNull();
    expect(whyOf(world, id)).toEqual({ why_text: null, why_source: null });
  });

  it("answers the summary the card falls back on", async () => {
    const { world, browser, id } = await edited();
    world.links
      .prepare(
        "UPDATE links SET summary = 'About quokkas', summary_source = 'inferred' WHERE id = ?",
      )
      .run(Number(id));
    const res = await edit(browser, { id, why: "mine", whySeen: NONE });
    expect((res.body as WhyAnswer).summary).toBe("About quokkas");
  });

  it("a Save without why leaves it alone, a title-only one included", async () => {
    const { world, browser, id } = await edited();
    seed(world, id, "a guess", "inferred");
    const res = await edit(browser, { id, title: "Quokkas again" });
    expect(res.status).toBe(200);
    expect(whyOf(world, id)).toEqual({ why_text: "a guess", why_source: "inferred" });
    expect((res.body as WhyAnswer).why).toEqual({ text: "a guess", source: "inferred" });
  });

  it("refuses a stale whySeen with a 409 and WHY_CONFLICT, writing nothing, title included", async () => {
    const { world, browser, id } = await edited();
    seed(world, id, "now", "asked");
    const before = allRows(world);
    const res = await edit(browser, {
      id,
      title: "Other",
      why: "mine",
      whySeen: seenOf("then", "asked"),
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ message: WHY_CONFLICT });
    expect(allRows(world)).toEqual(before);
  });

  it("refuses why without whySeen, and a whySeen that is not {text, source} or null, with a 400", async () => {
    const { world, browser, id } = await edited();
    const before = allRows(world);
    const bad: Record<string, string>[] = [
      { id, why: "mine" },
      { id, whySeen: NONE },
      { id, why: "mine", whySeen: "not json" },
      { id, why: "mine", whySeen: JSON.stringify({ text: 3, source: "stated" }) },
      { id, why: "mine", whySeen: JSON.stringify({ text: "x" }) },
      { id, why: "mine", whySeen: JSON.stringify("x") },
      { id, why: "mine", whySeen: seenOf("x", "bogus") },
    ];
    for (const fields of bad) {
      expect((await edit(browser, fields)).status, JSON.stringify(fields)).toBe(400);
    }
    expect(allRows(world)).toEqual(before);
  });
});
