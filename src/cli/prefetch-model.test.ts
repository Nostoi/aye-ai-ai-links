import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST, revisionDir } from "../search/model.js";
import { prefetchModel } from "./prefetch-model.js";

const roots: string[] = [];
const emptyRoot = () => {
  const r = mkdtempSync(join(tmpdir(), "aye-prefetch-"));
  roots.push(r);
  return r;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

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

  it("by default loads through the pinned-file check", async () => {
    await expect(prefetchModel(emptyRoot(), { install: async () => {} })).rejects.toThrow(
      /not as pinned/,
    );
  });

  it("by default installs through the given fetch", async () => {
    await expect(
      prefetchModel(emptyRoot(), {
        fetchFn: () => Promise.reject(new Error("offline")),
        load: async () => {},
      }),
    ).rejects.toThrow(/Could not install/);
  });

  it("is the CLI that deploy.sh runs", () => {
    const script = readFileSync(join(import.meta.dirname, "../../deploy/deploy.sh"), "utf8");
    const built = [...script.matchAll(/dist\/cli\/([\w-]+)\.js/g)].map((m) => m[1]);
    expect(built).toContain("prefetch-model-main");
    for (const name of built) {
      expect(existsSync(join(import.meta.dirname, `${name}.ts`)), name).toBe(true);
    }
  });
});
