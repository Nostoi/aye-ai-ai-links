import { LINK_ORDERS, type LinkOrder } from "../core/search.js";
import { escapeHtml } from "./page.js";

/** What each order is called wherever the owner picks one. */
export const ORDER_NAMES: Record<LinkOrder, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  opened: "Recently opened",
};

/**
 * The order choices as links, the current one marked. `href` is the address of a page in an order,
 * so All links and a space page each keep their own addresses.
 */
export const orderNav = (order: LinkOrder, href: (order: LinkOrder) => string) =>
  `<nav class="orders" aria-label="Order">${LINK_ORDERS.map(
    (o) =>
      `<a href="${escapeHtml(href(o))}"${o === order ? ' aria-current="true"' : ""}>${ORDER_NAMES[o]}</a>`,
  ).join(`<span aria-hidden="true">·</span>`)}</nav>`;

/**
 * The same choices as a select, for a phone: a GET form to `action` carrying `hidden` fields, whose
 * newest option is empty so that choice sends no `order` and lands on the plain address.
 * `orderSelectScript` submits it on a change.
 */
export const orderSelect = (
  order: LinkOrder,
  { action, hidden }: { action: string; hidden: Record<string, string> },
) => `<form class="order-select" action="${escapeHtml(action)}" method="get">
${Object.entries(hidden)
  .map(
    ([name, value]) =>
      `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
  )
  .join("\n")}
<label class="visually-hidden" for="order">Order</label>
<select id="order" name="order">
${LINK_ORDERS.map(
  (o) =>
    `<option value="${o === "newest" ? "" : o}"${o === order ? " selected" : ""}>${ORDER_NAMES[o]}</option>`,
).join("\n")}
</select>
</form>`;

/**
 * The select's script, a block for the page's script: a change submits the form. The select is
 * named `order` for any choice but the empty newest, and nameless for that one, which a form
 * leaves out, so newest sends no `order`.
 */
export const orderSelectScript = `{
const orderForm = document.querySelector("form.order-select");
if (orderForm) {
  const orderField = orderForm.querySelector("select");
  orderField.addEventListener("change", () => {
    orderField.setAttribute("name", orderField.value === "" ? "" : "order");
    orderForm.submit();
  });
  document.defaultView.addEventListener("pageshow", () => {
    for (const option of orderField.querySelectorAll("option")) option.selected = option.defaultSelected;
    orderField.setAttribute("name", "order");
  });
}
}`;
