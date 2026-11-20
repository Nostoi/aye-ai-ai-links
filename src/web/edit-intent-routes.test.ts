import { describe, expect, it } from "vitest";
import { allRows } from "../auth/oauth-test-kit.js";
import { KEPT_TOOL_STAYS } from "../core/intent.js";
import { keepHandy } from "../core/tools.js";
import { A, type Answer, edit, edited, linkDeps, undo } from "./edit-routes-kit.js";

const EXPLORE = JSON.stringify({ intent: "explore", source: null });
const intentOf = (world: Awaited<ReturnType<typeof edited>>["world"], id: string) =>
  world.links.prepare("SELECT intent, intent_source FROM links WHERE id = ?").get(Number(id));
const receipts = (world: Awaited<ReturnType<typeof edited>>["world"]) =>
  world.links.prepare("SELECT count(*) AS n FROM link_edits").get();

describe("intent in POST /links/edit and its Undo", () => {
  it("writes the choice as stated, answers the card's intent and an edit id, and Undo gives the old pair back", async () => {
    const { world, browser, id } = await edited();
    const res = await edit(browser, { id, intent: "keep", intentSeen: EXPLORE });
    expect(res.status).toBe(200);
    const body = res.body as Answer & { intent: string; intentSource: string | null };
    expect([body.intent, body.intentSource]).toEqual(["keep", "stated"]);
    expect(body.editId).toEqual(expect.any(String));
    expect(intentOf(world, id)).toEqual({ intent: "keep", intent_source: "stated" });
    const back = await undo(browser, { id, editId: body.editId });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ intent: "explore", intentSource: null });
    expect(intentOf(world, id)).toEqual({ intent: "explore", intent_source: null });
  });

  it("a Save that sends no intent leaves it alone, a title-only one included", async () => {
    const { world, browser, id } = await edited();
    await edit(browser, { id, intent: "keep", intentSeen: EXPLORE });
    const res = await edit(browser, { id, title: "Quokkas again" });
    expect(res.status).toBe(200);
    expect(intentOf(world, id)).toEqual({ intent: "keep", intent_source: "stated" });
  });

  it("refuses a stale intentSeen with a 409, writing nothing, no receipt", async () => {
    const { world, browser, id } = await edited();
    await edit(browser, { id, intent: "keep", intentSeen: EXPLORE });
    const before = allRows(world);
    const receiptsBefore = receipts(world);
    const res = await edit(browser, { id, title: "Other", intent: "explore", intentSeen: EXPLORE });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ message: expect.stringContaining("intent changed") });
    expect(allRows(world)).toEqual(before);
    expect(receipts(world)).toEqual(receiptsBefore);
  });

  it("refuses an intent without intentSeen, and a bad one, with a 400 and nothing written", async () => {
    const { world, browser, id } = await edited();
    const before = allRows(world);
    const bad: Record<string, string>[] = [
      { id, intent: "keep" },
      { id, intentSeen: EXPLORE },
      { id, intent: "keep", intentSeen: "not json" },
      { id, intent: "keep", intentSeen: JSON.stringify({ intent: 3, source: null }) },
      { id, intent: "maybe", intentSeen: EXPLORE },
    ];
    for (const fields of bad) {
      expect((await edit(browser, fields)).status, JSON.stringify(fields)).toBe(400);
    }
    expect(allRows(world)).toEqual(before);
  });

  it("refuses an explore on a kept tool by name, writing nothing and no receipt", async () => {
    const { world, browser, id } = await edited();
    await keepHandy(linkDeps(world), A, id, "stated");
    const before = allRows(world);
    const receiptsBefore = receipts(world);
    const seen = JSON.stringify({ intent: "keep", source: "stated" });
    const res = await edit(browser, { id, intent: "explore", intentSeen: seen });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ message: KEPT_TOOL_STAYS });
    expect(allRows(world)).toEqual(before);
    expect(receipts(world)).toEqual(receiptsBefore);
  });
});
