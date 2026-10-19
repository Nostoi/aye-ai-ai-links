import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { spacesSection } from "./spaces-section.js";

it("★ renders a contain cell as a whole icon, a cover cell as a photo, and tints the rest", () => {
  const html = spacesSection([
    {
      key: "k",
      name: "K",
      color: "clay",
      mosaic: [
        { linkId: "1", version: "a", fit: "contain" },
        { linkId: "2", version: "b", fit: "cover" },
      ],
    },
  ]);
  const cells = [...parseHTML(html).document.querySelectorAll(".mosaic > *")];
  expect(cells.map((c) => c.outerHTML)).toEqual([
    '<div class="mosaic-icon"><img class="site-icon" src="/images/1?v=a" alt="" loading="lazy"></div>',
    '<img src="/images/2?v=b" alt="" loading="lazy">',
    '<div class="tint-3"></div>',
  ]);
});
