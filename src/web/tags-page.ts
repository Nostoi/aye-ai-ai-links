import { SPACE_COLORS } from "../core/tag-space.js";
import type { Tag } from "../core/types.js";
import { escapeHtml, page } from "./page.js";

/** Only a project an AI guessed is shown as a guess; a topic is the default kind. */
const isGuess = (t: Tag) => t.kind === "project" && t.kindSource === "inferred";

const kindLabel = (t: Tag) =>
  isGuess(t)
    ? "Project? (a guess)"
    : t.kind === "topic"
      ? "Topic"
      : t.projectStatus === "done"
        ? "Project, done"
        : "Project";

const pressed = (on: boolean) => `aria-pressed="${on}"`;
const spaceClass = (color: string | null) => (color ? ` space-${escapeHtml(color)}` : "");

function tagItem(t: Tag, i: number): string {
  const guess = isGuess(t);
  const project = t.kind === "project";
  const done = t.projectStatus === "done";
  const swatches = SPACE_COLORS.map(
    (c) =>
      `<button type="button" class="swatch space-${c}" data-color="${c}" aria-label="${c}" ${pressed(t.color === c)}></button>`,
  ).join("");
  return `<li class="tag" data-key="${escapeHtml(t.key)}" data-color="${escapeHtml(t.color ?? "")}" data-pinned="${t.pinned}">
<div class="tag-row">
<h2><span class="dot${spaceClass(t.color)}" aria-hidden="true"></span><span class="tag-name">${escapeHtml(t.name)}</span><span class="kind">${kindLabel(t)}</span></h2>
<button type="button" class="pill" data-action="pin" ${pressed(t.pinned)}>${t.pinned ? "Pinned to home" : "Pin to home"}</button>
<button type="button" data-action="edit" aria-expanded="false" aria-controls="edit-${i}">Edit</button>
</div>
<div class="tag-edit" id="edit-${i}" hidden>
<fieldset><legend>Kind</legend><div class="choices"><button type="button" class="pill" data-kind="topic" ${pressed(!guess && !project)}>Topic</button><button type="button" class="pill" data-kind="project" ${pressed(!guess && project)}>Project</button></div>
<p class="small guess-note"${guess ? "" : " hidden"}>An AI guessed this. Pick one to confirm.</p></fieldset>
<fieldset class="status"${project ? "" : " hidden"}><legend>Status</legend><div class="choices"><button type="button" class="pill" data-status="active" ${pressed(!done)}>Working on it</button><button type="button" class="pill" data-status="done" ${pressed(done)}>Done</button></div></fieldset>
<fieldset><legend>Color</legend><div class="swatches">${swatches}</div><p class="small shared" hidden></p></fieldset>
</div>
</li>`;
}

/**
 * The owner's tags: pin one to make it a space, and set its kind, status and color.
 *
 * Each action posts `{key, ...}` with `redirect: "manual"` and counts as done only when the answer
 * is 200 with the same tag; the row is then drawn from that tag, never from what was asked, so
 * the color a pin gets is the server's. A refusal shows the server's message. Unpin and Done show
 * the Undo bar; Undo pins the tag again (it kept its color) or reopens the project. Each color
 * swatch names the other pinned tags that use it, and a tag whose color another pinned tag uses
 * says so under its swatches.
 */
export const tagsPage = ({ tags }: { tags: Tag[] }) =>
  page(
    "Tags · Aye-AI-AI Links",
    `<main class="tags">
<h1>Tags</h1>
<p class="lead">Pinned tags are your spaces on the home page. Each one keeps its color everywhere.</p>
<p id="tags-error" role="alert"></p>
${tags.length === 0 ? "<p>No tags yet. Your AI adds tags when it saves a link.</p>" : `<ul class="tag-list" id="tags">\n${tags.map(tagItem).join("\n")}\n</ul>`}
</main>
<script>
const list = document.getElementById("tags");
const tagsError = document.getElementById("tags-error");
const COLORS = ${JSON.stringify(SPACE_COLORS)};

const post = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
  }).catch(() => null);

/** The server's own message for a refusal, else a generic one. */
const failure = async (res) => {
  const data = res && [400, 404, 409].includes(res.status) ? await res.json().catch(() => null) : null;
  return data && typeof data.message === "string"
    ? data.message
    : "That did not work. Reload the page and try again.";
};

const setPressed = (el, on) => el.setAttribute("aria-pressed", String(on));
const nameOf = (row) => row.querySelector(".tag-name").textContent;

/** Each swatch names the other pinned tags with its color; a shared color is said under them. */
const markShared = () => {
  const rows = [...list.querySelectorAll("li[data-key]")];
  for (const row of rows) {
    const others = (color) =>
      rows
        .filter((r) => r !== row && r.dataset.pinned === "true" && r.dataset.color === color)
        .map(nameOf);
    for (const swatch of row.querySelectorAll(".swatch")) {
      const names = others(swatch.dataset.color);
      swatch.setAttribute(
        "aria-label",
        names.length ? swatch.dataset.color + ", also used by " + names.join(", ") : swatch.dataset.color,
      );
    }
    const mine = row.dataset.color ? others(row.dataset.color) : [];
    const note = row.querySelector(".shared");
    note.textContent = mine.length
      ? mine.join(", ") + (mine.length > 1 ? " also use this color." : " also uses this color.")
      : "";
    note.hidden = mine.length === 0;
  }
};

/** Draws a row from the tag the server returned. */
const draw = (row, tag) => {
  const guess = tag.kind === "project" && tag.kindSource === "inferred";
  const project = tag.kind === "project";
  const done = tag.projectStatus === "done";
  const color = COLORS.includes(tag.color) ? tag.color : "";
  row.dataset.color = color;
  row.dataset.pinned = String(tag.pinned === true);
  row.querySelector(".kind").textContent = guess
    ? "Project? (a guess)"
    : !project
      ? "Topic"
      : done
        ? "Project, done"
        : "Project";
  row.querySelector(".dot").className = color ? "dot space-" + color : "dot";
  const pin = row.querySelector('[data-action="pin"]');
  setPressed(pin, tag.pinned === true);
  pin.textContent = tag.pinned === true ? "Pinned to home" : "Pin to home";
  setPressed(row.querySelector('[data-kind="topic"]'), !guess && !project);
  setPressed(row.querySelector('[data-kind="project"]'), !guess && project);
  row.querySelector(".guess-note").hidden = !guess;
  row.querySelector("fieldset.status").hidden = !project;
  setPressed(row.querySelector('[data-status="active"]'), !done);
  setPressed(row.querySelector('[data-status="done"]'), done);
  for (const swatch of row.querySelectorAll(".swatch")) {
    setPressed(swatch, swatch.dataset.color === color);
  }
  markShared();
};

/** Posts one action for the row's tag; draws and returns the tag sent back, else says why. */
const act = async (row, url, body) => {
  tagsError.textContent = "";
  const res = await post(url, { key: row.dataset.key, ...body });
  const data = res && res.status === 200 ? await res.json().catch(() => null) : null;
  const tag = data && data.tag;
  if (tag && tag.key === row.dataset.key) {
    draw(row, tag);
    return tag;
  }
  tagsError.textContent = await failure(res);
  return null;
};

const toggleEdit = (button, row) => {
  const open = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(open));
  button.textContent = open ? "Close" : "Edit";
  row.querySelector(".tag-edit").hidden = !open;
};

/** Runs the action a button names; resolves to the Undo to offer, if any. */
const run = async (button, row) => {
  const name = nameOf(row);
  if (button.dataset.action === "pin") {
    const pinned = button.getAttribute("aria-pressed") !== "true";
    const tag = await act(row, "/tags/pin", { pinned });
    return tag && !pinned
      ? [name + " unpinned.", () => act(row, "/tags/pin", { pinned: true })]
      : null;
  }
  if (button.dataset.kind) {
    await act(row, "/tags/kind", { kind: button.dataset.kind });
    return null;
  }
  if (button.dataset.status) {
    const tag = await act(row, "/tags/status", { status: button.dataset.status });
    return tag && button.dataset.status === "done"
      ? [name + " marked done.", () => act(row, "/tags/status", { status: "active" })]
      : null;
  }
  if (button.dataset.color) await act(row, "/tags/color", { color: button.dataset.color });
  return null;
};

if (list) {
  markShared();
  list.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    const row = button && button.closest("li[data-key]");
    if (!row || button.disabled) return;
    if (button.dataset.action === "edit") return toggleEdit(button, row);
    button.disabled = true;
    const undo = await run(button, row);
    // Enabled before the Undo bar takes focus, so focus can come back to it.
    button.disabled = false;
    if (undo) showUndo(undo[0], undo[1]);
  });
}
</script>`,
    { menu: true, undo: true },
  );
