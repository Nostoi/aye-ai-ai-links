import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Inside node_modules so the build output resolves its dependencies and stays git-ignored.
const outDir = path.join(root, `node_modules/.cache/aye-dist-test-${process.pid}`);

afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

describe("the deployed path", () => {
  it("builds, then extracts through dist/ the way the LaunchAgent runs node", () => {
    fs.rmSync(outDir, { recursive: true, force: true });
    execFileSync("npx", ["tsc", "-p", "tsconfig.build.json", "--outDir", outDir], {
      cwd: root,
      stdio: "pipe",
    });
    const runner = pathToFileURL(path.join(outDir, "fetch/extract-runner.js")).href;
    const script = `
      const { createChildExtractor, CHILD_ENTRY } = await import(process.argv[1]);
      const extractor = createChildExtractor();
      const out = await extractor.extract(
        "<!doctype html><html><head><title>Dist</title></head><body><article><h1>Q</h1><p>" + "Quokkas live on Rottnest island and are friendly. ".repeat(20) + "</p></article></body></html>",
        "https://example.com/",
      );
      await extractor.close();
      console.log(JSON.stringify({ entry: CHILD_ENTRY.href, out }));
    `;
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script, runner], {
      cwd: root,
      env: {},
    }).toString();
    const result = JSON.parse(stdout);
    expect(result.entry).toMatch(/\/aye-dist-test-\d+\/fetch\/extract-child\.js$/);
    expect(result.out.kind, JSON.stringify(result.out)).toBe("ok");
    expect(result.out.metadata.title).toBe("Dist");
    expect(result.out.text).toContain("Rottnest");
  }, 60_000);
});
