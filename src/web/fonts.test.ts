import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { memoryAuth, TEST_BASE_URL } from "../auth/memory-auth.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";
import { SqliteKeyStore } from "../store/key-store.js";
import { FONTS, FRAUNCES_QUESTION, OPEN_RUNDE } from "./fonts.js";
import { themeCss } from "./theme.js";

async function get(path: string) {
  const auth = await memoryAuth();
  const db = openDatabase(":memory:");
  const { app } = createApp({
    deps: createDeps(db, new FakeEmbedder(DIMS)),
    identify: async () => null,
    auth: { ...auth, keys: new SqliteKeyStore(db) },
  });
  return app.fetch(new Request(`${TEST_BASE_URL}${path}`, { redirect: "manual" }));
}

const onDisk = (file: string) =>
  readFileSync(new URL(`../../assets/fonts/${file}`, import.meta.url));

describe("the font routes", () => {
  it("serves five fonts, each file once", () => {
    expect(FONTS.map((f) => f.file).sort()).toEqual([
      "fraunces-question.woff2",
      "open-runde-400.woff2",
      "open-runde-500.woff2",
      "open-runde-600.woff2",
      "open-runde-700.woff2",
    ]);
  });

  it.each(FONTS)(
    "serves $file to anyone, as the file's own bytes, cached for good at its version",
    async (font) => {
      const res = await get(`${font.path}?v=${font.version}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("font/woff2");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(Buffer.from(await res.arrayBuffer()).equals(onDisk(font.file))).toBe(true);
    },
  );

  it.each([
    ["no version", ""],
    ["a wrong version", "?v=0000"],
  ])("never caches for good with %s", async (_, query) => {
    const font = FRAUNCES_QUESTION;
    const res = await get(`${font.path}${query}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it.each([
    "/fonts/unknown.woff2",
    "/fonts/open-runde-800.woff2",
    "/fonts/..%2fVERSION",
    "/fonts/..%2f..%2fpackage.json",
    "/fonts/%2e%2e/VERSION",
    "/fonts/",
    "/fonts",
  ])("answers no font at %s", async (path) => {
    const res = await get(path);
    expect(res.status).not.toBe(200);
    expect(res.headers.get("content-type") ?? "").not.toMatch(/font|octet/);
  });
});

describe("the theme's fonts", () => {
  it.each(FONTS)("asks for $file at the address the route caches for good", async (font) => {
    const url = `${font.path}?v=${font.version}`;
    expect(themeCss).toContain(`url(${url})`);
    expect((await get(url)).headers.get("cache-control")).toContain("immutable");
  });

  it("changes the address when the file's bytes change", () => {
    const versions = FONTS.map((f) => f.version);
    expect(new Set(versions).size).toBe(FONTS.length);
    for (const f of FONTS) {
      expect(f.version).toBe(
        createHash("sha256").update(onDisk(f.file)).digest("hex").slice(0, 12),
      );
    }
  });

  it("declares each Open Runde weight and the Fraunces face, all swapping", () => {
    for (const { weight } of OPEN_RUNDE) {
      expect(themeCss).toMatch(
        new RegExp(
          `@font-face\\{font-family:"Open Runde";font-weight:${weight};[^}]*font-display:swap`,
        ),
      );
    }
    expect(themeCss).toMatch(
      /@font-face\{font-family:"Fraunces Question";font-weight:760;[^}]*font-display:swap/,
    );
  });

  it("puts Open Runde first on the body and Fraunces on the question", () => {
    expect(themeCss).toMatch(/body\{[^}]*font-family:"Open Runde", ui-rounded/);
    expect(themeCss).toMatch(
      /\.question\{[^}]*font-family:"Fraunces Question", "Open Runde", serif/,
    );
  });
});
