import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { oauthWorld } from "./oauth-test-kit.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("oauthWorld savedCopyDir", () => {
  it("gives the world a ready saved-copy store on that folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aye-world-copies-"));
    dirs.push(dir);
    const world = await oauthWorld({ savedCopyDir: dir });
    expect(await world.savedCopies.checkFolder()).toEqual({ state: "ready" });
  });

  it("refuses a folder that is not ready", async () => {
    await expect(oauthWorld({ savedCopyDir: "/dev/null/nope" })).rejects.toThrow(/not ready/);
  });
});
