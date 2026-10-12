import { afterEach, describe, expect, it, vi } from "vitest";
import { saveLink } from "./core/links.js";
import type { SearchTrace } from "./core/search.js";
import { createDeps } from "./deps.js";
import { FakeEmbedder } from "./search/embedder.js";
import { DIMS, MODEL_KEY } from "./search/model.js";
import { openDatabase } from "./store/database.js";

const OWNER = "o";

describe("createDeps", () => {
  afterEach(() => vi.restoreAllMocks());

  it("wires meaning search: a link matching only by meaning is found without the keyword fallback", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = openDatabase(":memory:");
    const embedder = new FakeEmbedder(DIMS);
    const deps = createDeps(db, embedder);
    deps.store.ensureUser(OWNER, OWNER);
    const { link } = await saveLink(deps, OWNER, {
      url: "https://ex.com/a",
      title: "alpha",
      savedBy: "t",
    });
    const [vector] = await embedder.embedDocuments(["quokka"]);
    const v = vector as Float32Array;
    db.prepare("INSERT INTO link_vectors VALUES (?, ?, ?, ?, 'h', ?, 0)").run(
      OWNER,
      Number(link.id),
      MODEL_KEY,
      v.length,
      Buffer.from(v.buffer),
    );
    const traces: SearchTrace[] = [];

    const ids = await deps.search.search(OWNER, "quokka", {}, 5, (t) => traces.push(t));

    expect(logged).not.toHaveBeenCalled();
    expect(traces).toEqual([
      {
        mode: "hybrid",
        embedded: "quokka",
        modelKey: MODEL_KEY,
        similarity: { [link.id]: 1 },
        meaningCandidates: 1,
      },
    ]);
    expect(ids).toEqual([link.id]);
    db.close();
  });
});
