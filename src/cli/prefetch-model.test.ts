import { describe, expect, it } from "vitest";
import { MANIFEST, revisionDir } from "../search/model.js";
import { prefetchModel } from "./prefetch-model.js";

const fetchFn = () => Promise.reject(new Error("not used"));

describe("prefetchModel", () => {
  it("installs the pinned files, then loads from the revision folder", async () => {
    const calls: string[] = [];
    const dir = await prefetchModel("/root", {
      fetchFn,
      install: async (d, manifest, f) => {
        calls.push(`install ${d} ${manifest === MANIFEST} ${f === fetchFn}`);
      },
      load: async (d) => {
        calls.push(`load ${d}`);
      },
    });
    expect(dir).toBe(revisionDir("/root"));
    expect(calls).toEqual([`install ${dir} true true`, `load ${dir}`]);
  });

  it("rejects when the load rejects", async () => {
    await expect(
      prefetchModel("/root", {
        install: async () => {},
        load: async () => {
          throw new Error("canary mismatch");
        },
      }),
    ).rejects.toThrow("canary mismatch");
  });

  it("does not load when the install rejects", async () => {
    let loaded = false;
    await expect(
      prefetchModel("/root", {
        install: async () => {
          throw new Error("download failed");
        },
        load: async () => {
          loaded = true;
        },
      }),
    ).rejects.toThrow("download failed");
    expect(loaded).toBe(false);
  });
});
