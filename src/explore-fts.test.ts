import { describe, expect, it } from "vitest";
import { saveLink } from "./core/links.js";
import { addProfile } from "./core/profile.js";
import { tellWhy, worthALook } from "./core/worth-a-look.js";
import { createDeps } from "./deps.js";
import { FakeEmbedder } from "./search/embedder.js";
import { DIMS } from "./search/model.js";
import { openDatabase } from "./store/database.js";

const OWNER = "o";
const DAY = 86_400_000;

/** Real SQLite and the real keyword search, with a clock the test moves. */
function world() {
  const db = openDatabase(":memory:");
  let clock = new Date("2026-03-01T00:00:00Z");
  const deps = { ...createDeps(db, new FakeEmbedder(DIMS)), now: () => clock };
  deps.store.ensureUser(OWNER, OWNER);
  const save = async (title: string, why: string | null = "to read") =>
    (
      await saveLink(deps, OWNER, {
        url: `https://ex.com/${title.replace(/\W+/g, "-")}`,
        title,
        why: why === null ? null : { text: why, source: "stated" },
        savedBy: "t",
      })
    ).link;
  const advance = (days: number) => {
    clock = new Date(clock.getTime() + days * DAY);
  };
  const explore = async () => (await worthALook(deps, OWNER, [])).links.map((c) => c.link.id);
  return { db, deps, save, advance, explore };
}

describe("Explore's featured card on real keyword search (#340)", () => {
  const seed = async () => {
    const w = world();
    const oldest = await w.save("Old chess notes");
    w.advance(1);
    const matching = [];
    for (const title of [
      "Solar roof guide",
      "Solar panel sizing",
      "Solar battery",
      "Solar permits",
    ]) {
      matching.push(await w.save(title, matching.length === 0 ? null : "to read"));
      w.advance(1);
    }
    w.advance(25);
    for (const title of ["Bread baking", "Chess openings", "Garden soil"]) {
      await w.save(title);
      w.advance(1);
    }
    await addProfile(w.deps, OWNER, "t", { addFocus: [{ text: "solar", source: "stated" }] });
    return { ...w, matching, oldest };
  };

  it("keeps the same featured card after Tell me why, whose words sit outside the focus text", async () => {
    const w = await seed();
    const before = await w.explore();
    expect(before[0]).toBe(w.matching[0]?.id);
    await tellWhy(w.deps, OWNER, before[0] as string, "for the garage extension next spring");
    expect(await w.explore()).toEqual(before);
    w.db.close();
  });

  it("keeps the same featured card when six unrelated links that share a focus word are saved", async () => {
    const w = await seed();
    const before = await w.explore();
    for (let i = 0; i < 6; i++) {
      w.advance(1);
      await w.save(`Solar forum thread ${i}`);
    }
    expect(await w.explore()).toEqual(before);
    w.db.close();
  });

  it("puts one focus match first, though an older link exists, and the rest oldest first", async () => {
    const w = await seed();
    expect(await w.explore()).toEqual([w.matching[0]?.id, w.oldest.id, w.matching[1]?.id]);
    w.db.close();
  });
});
