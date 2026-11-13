import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** One font file the pages use: served at `path`, read once from `assets/fonts/`. */
export type Font = { file: string; path: string; bytes: Buffer; version: string };

const load = (file: string): Font => {
  const bytes = readFileSync(new URL(`../../assets/fonts/${file}`, import.meta.url));
  return {
    file,
    path: `/fonts/${file}`,
    bytes,
    version: createHash("sha256").update(bytes).digest("hex").slice(0, 12),
  };
};

/** Open Runde, the body font, one file per weight. */
export const OPEN_RUNDE = ([400, 500, 600, 700] as const).map((weight) => ({
  weight,
  font: load(`open-runde-${weight}.woff2`),
}));

/** The one static Fraunces face, for Home's question. */
export const FRAUNCES_QUESTION = load("fraunces-question.woff2");

/** Every font the app serves, by exact path: no other `/fonts/…` path answers. */
export const FONTS: readonly Font[] = [...OPEN_RUNDE.map((o) => o.font), FRAUNCES_QUESTION];

/** The address a stylesheet uses: the version in it makes the file's cache entry permanent. */
export const fontUrl = (font: Font) => `${font.path}?v=${font.version}`;

/** A font's headers: cached for a year only when the request names the file's current version. */
export const fontHeaders = (font: Font, requested: string | undefined) => ({
  "Content-Type": "font/woff2",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": requested === font.version ? "public, max-age=31536000, immutable" : "no-cache",
});
