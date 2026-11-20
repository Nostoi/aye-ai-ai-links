import { describe, expect, it } from "vitest";
import { FakeStore } from "./fake-store.js";
import { KEPT_TOOL_STAYS } from "./intent.js";
import { saveLink, updateLink, updateLinkWithReceipt } from "./links.js";
import type { ToolRecord } from "./tool-store.js";

const A = "a";
const deps = () => ({ store: new FakeStore(), now: () => new Date("2026-01-01T00:00:00Z") });
const tool: ToolRecord = {
  status: "kept",
  source: "stated",
  since: new Date("2026-01-01T00:00:00Z"),
  answeredAt: null,
  waitDays: 30,
};
const intentOf = (l: { intent: string; intentSource: string | null }) => [l.intent, l.intentSource];

describe("saveLink and intent", () => {
  it("starts a link as explore with nobody's say", async () => {
    const { link } = await saveLink(deps(), A, { url: "https://ex.com/1", savedBy: "t" });
    expect(intentOf(link)).toEqual(["explore", null]);
  });

  it("saves the intent and source it is given", async () => {
    const d = deps();
    const inferred = await saveLink(d, A, {
      url: "https://ex.com/2",
      savedBy: "t",
      intent: "keep",
      intentSource: "inferred",
    });
    expect(intentOf(inferred.link)).toEqual(["keep", "inferred"]);
    expect(intentOf((await d.store.get(A, inferred.link.id)) as never)).toEqual([
      "keep",
      "inferred",
    ]);
  });

  it("refuses an intent without a source, and a source without an intent, saving nothing", async () => {
    const d = deps();
    const base = { url: "https://ex.com/3", savedBy: "t" };
    await expect(saveLink(d, A, { ...base, intent: "keep" })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("intentSource"),
    });
    await expect(saveLink(d, A, { ...base, intentSource: "stated" })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("needs an intent"),
    });
    expect(await d.store.listLinks(A)).toEqual([]);
  });

  it("a repeat save changes no intent", async () => {
    const d = deps();
    const first = await saveLink(d, A, { url: "https://ex.com/4", savedBy: "t" });
    const again = await saveLink(d, A, {
      url: "https://ex.com/4",
      savedBy: "t",
      intent: "keep",
      intentSource: "stated",
    });
    expect(again.created).toBe(false);
    expect(intentOf(again.link)).toEqual(["explore", null]);
    expect(intentOf((await d.store.get(A, first.link.id)) as never)).toEqual(["explore", null]);
  });
});

describe("updateLink and intent", () => {
  const saved = async (d = deps()) => ({
    d,
    id: (await saveLink(d, A, { url: "https://ex.com/u", savedBy: "t" })).link.id,
  });

  it("writes a stated intent, and an inferred one over nothing or another guess", async () => {
    const { d, id } = await saved();
    const guess = await updateLink(d, A, id, { intent: "keep", intentSource: "inferred" });
    expect(intentOf(guess)).toEqual(["keep", "inferred"]);
    const again = await updateLink(d, A, id, { intent: "explore", intentSource: "inferred" });
    expect(intentOf(again)).toEqual(["explore", "inferred"]);
    const said = await updateLink(d, A, id, { intent: "keep", intentSource: "stated" });
    expect(intentOf(said)).toEqual(["keep", "stated"]);
  });

  it("keeps an owner's intent when an agent's inferred write arrives, and writes the rest", async () => {
    const { d, id } = await saved();
    await updateLink(d, A, id, { intent: "keep", intentSource: "asked" });
    const after = await updateLink(d, A, id, {
      title: "New",
      intent: "explore",
      intentSource: "inferred",
    });
    expect([after.title, ...intentOf(after)]).toEqual(["New", "keep", "asked"]);
  });

  it("refuses an intent with no source, a source with no intent, and an unknown intent, writing nothing", async () => {
    const { d, id } = await saved();
    for (const input of [
      { intent: "keep" as const },
      { intentSource: "stated" as const },
      { intent: "maybe" as never, intentSource: "stated" as const },
      { title: "x", intent: "keep" as const, intentSource: "robot" as never },
    ]) {
      await expect(updateLink(d, A, id, input), JSON.stringify(input)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect((await d.store.get(A, id))?.title).toBeNull();
  });

  it("refuses an explore on a kept tool by name, writing nothing, through both update paths", async () => {
    const { d, id } = await saved();
    await updateLink(d, A, id, { intent: "keep", intentSource: "stated" });
    await d.store.updateToolIf(A, id, null, tool);
    const before = structuredClone(await d.store.get(A, id));
    for (const [name, write] of [
      [
        "updateLink",
        () => updateLink(d, A, id, { title: "T", intent: "explore", intentSource: "stated" }),
      ],
      [
        "updateLinkWithReceipt",
        () =>
          updateLinkWithReceipt(d, A, id, {
            title: "T",
            intent: "explore",
            intentSource: "stated",
          }),
      ],
    ] as const) {
      await expect(write(), name).rejects.toMatchObject({
        code: "conflict",
        message: KEPT_TOOL_STAYS,
      });
    }
    expect(await d.store.get(A, id)).toEqual(before);
    expect(await d.store.getTool(A, id)).toEqual(tool);
  });
});
