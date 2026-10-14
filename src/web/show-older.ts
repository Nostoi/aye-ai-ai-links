import { page } from "./page.js";

/**
 * "Show older links" (`#older`) is a real link to the next page. The script fetches that page
 * instead and appends the children of its `#list` to this page's, moving the link on to the page
 * after or removing it. A month section (`data-month`) that continues the last one shown joins
 * it, so no month is headed twice, whatever each page's heading says. If the answer is not a
 * page of cards, or was redirected (a session that ended goes to the sign-in page), it goes to
 * the link as a normal navigation.
 */
export const olderScript = (list: string) => `<script>
// A block, so these names cannot clash with another script on the page.
{
const older = document.getElementById("older");
const list = document.getElementById(${JSON.stringify(list)});
if (older && list) {
  older.addEventListener("click", async (event) => {
    event.preventDefault();
    if (older.getAttribute("aria-busy") === "true") return;
    const href = older.getAttribute("href");
    const go = () => {
      location.href = href;
    };
    older.setAttribute("aria-busy", "true");
    const res = await fetch(href, { headers: { accept: "text/html" } }).catch(() => null);
    if (!res || !res.ok || res.redirected) return go();
    const next = new DOMParser().parseFromString(await res.text(), "text/html");
    const cards = next.getElementById(${JSON.stringify(list)});
    if (!cards) return older.remove();
    const added = [...cards.children];
    const first = added[0] && added[0].querySelector("a");
    const month = (el) => (el ? el.getAttribute("data-month") : null);
    const last = list.lastElementChild;
    if (added[0] && month(added[0]) && month(added[0]) === month(last)) {
      last.querySelector("ul").append(...added.shift().querySelector("ul").children);
    }
    list.append(...added);
    const more = next.getElementById("older");
    if (more) {
      older.setAttribute("href", more.getAttribute("href"));
      older.removeAttribute("aria-busy");
    } else {
      older.remove();
    }
    if (first && first.focus) first.focus();
  });
}
}
</script>`;

/** For a page address that was changed or made by hand; `restart` says where to start again. */
export const olderInvalidPage = (restart: string) =>
  page(
    "Not valid · Aye-AI-AI Links",
    `<main>
<h1>That page of older links is not valid</h1>
<p>${restart}</p>
</main>`,
    { menu: true },
  );
