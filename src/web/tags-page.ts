import { SPACE_COLORS } from "../core/tag-space.js";
import type { Tag } from "../core/types.js";
import type { Ask } from "./ask-panel.js";
import { escapeHtml, page } from "./page.js";
import { spaceHref } from "./space-page.js";

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

export type TagEntry = { tag: Tag; links: number };
const linkCount = (n: number) => (n === 1 ? "1 link" : `${n} links`);

function tagItem({ tag: t, links }: TagEntry, i: number): string {
  const guess = isGuess(t);
  const project = t.kind === "project";
  const done = t.projectStatus === "done";
  const swatches = SPACE_COLORS.map(
    (c) =>
      `<button type="button" class="swatch space-${c}" data-color="${c}" aria-label="${c}" ${pressed(t.color === c)}></button>`,
  ).join("");
  return `<li class="tag" data-key="${escapeHtml(t.key)}" data-color="${escapeHtml(t.color ?? "")}" data-pinned="${t.pinned}" data-links="${links}">
<div class="tag-row">
<h2><span class="dot${spaceClass(t.color)}" aria-hidden="true"></span><a class="tag-name" href="${escapeHtml(spaceHref(t.key))}">${escapeHtml(t.name)}</a><span class="kind">${kindLabel(t)}</span><span class="count">· ${linkCount(links)}</span></h2>
<button type="button" class="pill" data-action="pin" ${pressed(t.pinned)}>${t.pinned ? "Pinned to home" : "Pin to home"}</button>
<button type="button" data-action="edit" aria-expanded="false" aria-controls="edit-${i}">Edit</button>
</div>
<div class="tag-edit" id="edit-${i}" hidden>
<div class="rename"><label for="name-${i}">Name</label><div class="rename-row"><input id="name-${i}" name="name" type="text" value="${escapeHtml(t.name)}" autocomplete="off"><button type="button" class="primary" data-action="rename">Rename</button></div></div>
<div class="taken" aria-live="polite" hidden><p></p><div class="choices"><button type="button" class="primary" data-action="merge-taken"></button><button type="button" class="quiet" data-action="keep"></button></div></div>
<fieldset><legend>Kind</legend><div class="choices"><button type="button" class="pill" data-kind="topic" ${pressed(!guess && !project)}>Topic</button><button type="button" class="pill" data-kind="project" ${pressed(!guess && project)}>Project</button></div>
<p class="small guess-note"${guess ? "" : " hidden"}>An AI guessed this. Pick one to confirm.</p></fieldset>
<fieldset class="status"${project ? "" : " hidden"}><legend>Status</legend><div class="choices"><button type="button" class="pill" data-status="active" ${pressed(!done)}>Working on it</button><button type="button" class="pill" data-status="done" ${pressed(done)}>Done</button></div></fieldset>
<fieldset><legend>Color</legend><div class="swatches">${swatches}</div><p class="small shared" hidden></p></fieldset>
<div class="tag-danger"><button type="button" class="quiet" data-action="merge-open" aria-expanded="false">Merge into another tag…</button><button type="button" class="quiet" data-action="delete">Delete tag</button></div>
<div class="merge" hidden><h3></h3><p></p><label for="filter-${i}">Find a tag</label><input id="filter-${i}" name="filter" type="text" autocomplete="off"><div class="picker"></div><div class="choices"><button type="button" class="primary" data-action="merge-go" disabled>Merge into…</button><button type="button" class="quiet" data-action="merge-cancel">Cancel</button></div></div>
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
 *
 * Each row shows its link count. The Edit panel also renames the tag, merges it into another, and
 * deletes it. Merge and Delete show the Undo bar; Undo posts the change id the answer gave. A row
 * takes one action at a time, and a merge and its Undo hold both rows.
 */
export const tagsPage = ({ tags, ask }: { tags: TagEntry[]; ask?: Ask | undefined }) =>
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

/** The JSON of a 200 or a refusal; null for anything else, such as a redirect to sign in. */
const readBody = (res) =>
  res && [200, 400, 404, 409].includes(res.status) ? res.json().catch(() => null) : Promise.resolve(null);

/** The server's own message for a refusal, else a generic one. */
const failure = (res, data) =>
  res && res.status !== 200 && data && typeof data.message === "string"
    ? data.message
    : "That did not work. Reload the page and try again.";

const setPressed = (el, on) => el.setAttribute("aria-pressed", String(on));
const nameOf = (row) => row.querySelector(".tag-name").textContent;
const rowsOf = () => [...list.querySelectorAll("li[data-key]")];
const rowFor = (key) => rowsOf().find((r) => r.dataset.key === key);
const linksText = (n) => (n === 1 ? "1 link" : n + " links");

/** Rows with a request out. An action on a held row sends nothing; an Undo waits for its rows. */
const held = new Set();
let waiting = [];
const hold = (rows) => rows.forEach((r) => held.add(r));
const release = (rows) => {
  rows.forEach((r) => held.delete(r));
  const wake = waiting;
  waiting = [];
  wake.forEach((f) => f());
};
const isHeld = (rows) => rows.some((r) => held.has(r));
const whenFree = async (rows) => {
  while (isHeld(rows)) await new Promise((r) => waiting.push(r));
};

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

/** Draws a row from the tag the server returned, and its link count when the answer had one. */
const draw = (row, tag, links) => {
  row.dataset.key = tag.key;
  const name = row.querySelector(".tag-name");
  name.textContent = tag.name;
  name.setAttribute("href", "/spaces?tag=" + encodeURIComponent(tag.key));
  row.querySelector('input[name="name"]').value = tag.name;
  if (links !== undefined) {
    row.dataset.links = String(links);
    row.querySelector(".count").textContent = "· " + linksText(links);
  }
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

/** Posts a request and reads its answer; \`data\` is set only for a 200. */
const send = async (url, body) => {
  tagsError.textContent = "";
  const res = await post(url, body);
  const answer = await readBody(res);
  return { res, answer, data: res && res.status === 200 ? answer : null };
};

/** Posts one action for the row's tag; draws and returns the tag sent back, else says why. */
const act = async (row, url, body) => {
  const { res, answer, data } = await send(url, { key: row.dataset.key, ...body });
  const tag = data && data.tag;
  if (tag && tag.key === row.dataset.key) {
    draw(row, tag);
    return tag;
  }
  tagsError.textContent = failure(res, answer);
  return null;
};

const hideTaken = (row) => {
  row.querySelector(".taken").hidden = true;
};

/** Rename is the one action that may change the row's key; a name another tag has offers a merge. */
const rename = async (row) => {
  hideTaken(row);
  const old = nameOf(row);
  const { res, answer, data } = await send("/tags/rename", {
    key: row.dataset.key,
    name: row.querySelector('input[name="name"]').value,
  });
  if (data && data.tag) return draw(row, data.tag);
  if (res && res.status === 409 && answer && answer.code === "taken" && answer.tag) {
    const box = row.querySelector(".taken");
    row.dataset.into = answer.tag.key;
    box.querySelector("p").textContent =
      "You already have a tag called " + answer.tag.name + " (" + linksText(answer.links) + "). Merge " + old + " into it?";
    box.querySelector('[data-action="merge-taken"]').textContent = "Merge into " + answer.tag.name;
    box.querySelector('[data-action="keep"]').textContent = "Keep " + old;
    box.hidden = false;
    return;
  }
  tagsError.textContent = failure(res, answer);
};

/** Puts a removed row back where it was, closed up, ready to be drawn from the Undo's answer. */
const putBack = (row, before) => {
  hideTaken(row);
  closeMerge(row);
  list.insertBefore(row, before && before.parentNode === list ? before : null);
};

/** Runs an Undo once its rows are free, holding them until it is answered. */
const holding = async (rows, fn) => {
  await whenFree(rows);
  hold(rows);
  try {
    return await fn();
  } finally {
    release(rows);
  }
};

/** Undoes a merge or delete and draws what the server puts back. */
const undoChange = (changeId, rows, restore) =>
  holding(rows, async () => {
    const { res, answer, data } = await send("/tags/undo", { changeId });
    if (!data || !Array.isArray(data.tags)) {
      tagsError.textContent = failure(res, answer);
      return;
    }
    restore();
    for (const entry of data.tags) {
      const row = rowFor(entry.tag.key);
      if (row) draw(row, entry.tag, entry.links);
    }
  });

/** Merges \`row\` into \`into\`; resolves to the Undo to offer. */
const merge = async (row, into) => {
  const name = nameOf(row);
  const { res, answer, data } = await send("/tags/merge", { key: row.dataset.key, into: into.dataset.key });
  if (!data || !data.tag || typeof data.changeId !== "string") {
    tagsError.textContent = failure(res, answer);
    return null;
  }
  const before = row.nextElementSibling;
  row.remove();
  draw(into, data.tag, data.links);
  return [
    "Merged " + name + " into " + data.tag.name + " (" + linksText(data.moved) + ").",
    () => undoChange(data.changeId, [row, into], () => putBack(row, before)),
  ];
};

const remove = async (row) => {
  const name = nameOf(row);
  const { res, answer, data } = await send("/tags/delete", { key: row.dataset.key });
  if (!data || typeof data.changeId !== "string") {
    tagsError.textContent = failure(res, answer);
    return null;
  }
  const before = row.nextElementSibling;
  row.remove();
  return [
    "Deleted " + name + " from " + linksText(data.moved) + ".",
    () => undoChange(data.changeId, [row], () => putBack(row, before)),
  ];
};

/** Opens the picker with the other tags as they are now, each with its count. */
const openMerge = (row) => {
  const panel = row.querySelector(".merge");
  const n = Number(row.dataset.links);
  panel.querySelector("h3").textContent = "Merge " + nameOf(row) + " into…";
  panel.querySelector("p").textContent =
    (n === 1 ? "Its 1 link moves" : "Its " + n + " links move") + " to the tag you pick, and " + nameOf(row) + " goes away.";
  panel.querySelector('input[name="filter"]').value = "";
  const picker = panel.querySelector(".picker");
  picker.replaceChildren();
  for (const other of rowsOf()) {
    if (other === row) continue;
    const pick = document.createElement("button");
    pick.setAttribute("type", "button");
    pick.setAttribute("class", "pick");
    pick.setAttribute("data-pick", other.dataset.key);
    pick.setAttribute("aria-pressed", "false");
    const label = document.createElement("span");
    label.textContent = nameOf(other);
    const count = document.createElement("span");
    count.className = "n";
    count.textContent = linksText(Number(other.dataset.links));
    pick.append(label, count);
    picker.append(pick);
  }
  setPick(row, null);
  panel.hidden = false;
  row.querySelector('[data-action="merge-open"]').setAttribute("aria-expanded", "true");
  panel.querySelector('input[name="filter"]').focus();
};

const closeMerge = (row) => {
  row.querySelector(".merge").hidden = true;
  setPick(row, null);
  row.querySelector('[data-action="merge-open"]').setAttribute("aria-expanded", "false");
};

/** Marks the picked tag (a pick button, or none) and names it on the Merge button. */
const setPick = (row, picked) => {
  row.dataset.pick = picked ? picked.dataset.pick : "";
  for (const pick of row.querySelectorAll(".pick")) setPressed(pick, pick === picked);
  const go = row.querySelector('[data-action="merge-go"]');
  go.textContent = picked ? "Merge into " + picked.firstChild.textContent : "Merge into…";
  go.disabled = !picked;
};

const filterPicks = (row, input) => {
  const wanted = input.value.trim().toLowerCase();
  for (const pick of row.querySelectorAll(".pick")) {
    pick.hidden = !pick.firstChild.textContent.toLowerCase().includes(wanted);
  }
};

const toggleEdit = (button, row) => {
  const open = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(open));
  button.textContent = open ? "Close" : "Edit";
  row.querySelector(".tag-edit").hidden = !open;
};

/** Runs the action a button names; resolves to the Undo to offer, if any. \`into\` is the row a merge keeps. */
const run = async (button, row, into) => {
  const name = nameOf(row);
  const action = button.dataset.action;
  if (action === "rename") {
    await rename(row);
    return null;
  }
  if (action === "delete") return remove(row);
  if (into) return merge(row, into);
  if (action === "pin") {
    const pinned = button.getAttribute("aria-pressed") !== "true";
    const tag = await act(row, "/tags/pin", { pinned });
    return tag && !pinned
      ? [name + " unpinned.", () => holding([row], () => act(row, "/tags/pin", { pinned: true }))]
      : null;
  }
  if (button.dataset.kind) {
    await act(row, "/tags/kind", { kind: button.dataset.kind });
    return null;
  }
  if (button.dataset.status) {
    // The status it already has: an Undo here would undo something done before.
    if (button.getAttribute("aria-pressed") === "true") return null;
    const tag = await act(row, "/tags/status", { status: button.dataset.status });
    return tag && button.dataset.status === "done"
      ? [
          name + " marked done.",
          () => holding([row], () => act(row, "/tags/status", { status: "active" })),
        ]
      : null;
  }
  if (button.dataset.color) await act(row, "/tags/color", { color: button.dataset.color });
  return null;
};

if (list) {
  markShared();
  // A space page's Change link comes as #tag=<key>: open that tag's panel. An unknown key opens none.
  const wanted = new URLSearchParams(location.hash.slice(1)).get("tag");
  const wantedRow = wanted && rowFor(wanted);
  if (wantedRow) {
    toggleEdit(wantedRow.querySelector('button[data-action="edit"]'), wantedRow);
    wantedRow.scrollIntoView();
  }
  const activate = async (button, row) => {
    const action = button.dataset.action;
    if (action === "edit") return toggleEdit(button, row);
    if (action === "merge-open") return openMerge(row);
    if (action === "merge-cancel") return closeMerge(row);
    if (action === "keep") {
      row.querySelector('input[name="name"]').value = nameOf(row);
      return hideTaken(row);
    }
    if (button.dataset.pick) return setPick(row, button);
    const into = action === "merge-go" ? rowFor(row.dataset.pick) : action === "merge-taken" ? rowFor(row.dataset.into) : null;
    if ((action === "merge-go" || action === "merge-taken") && !into) return;
    // A row takes one action at a time; a merge holds the kept row as well.
    const rows = into ? [row, into] : [row];
    if (isHeld(rows)) return;
    hold(rows);
    // Disabling the focused button drops focus to the page, so it is given back after.
    const hadFocus = document.activeElement === button;
    button.disabled = true;
    let undo = null;
    try {
      undo = await run(button, row, into);
    } finally {
      button.disabled = false;
      release(rows);
    }
    if (hadFocus) button.focus();
    if (undo) showUndo(undo[0], undo[1]);
  };
  list.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    const row = button && button.closest("li[data-key]");
    if (row && !button.disabled) return activate(button, row);
  });
  list.addEventListener("input", (event) => {
    if (event.target.name === "filter") filterPicks(event.target.closest("li[data-key]"), event.target);
  });
  list.addEventListener("keydown", (event) => {
    if (event.target.name !== "name" || event.key !== "Enter") return;
    event.preventDefault();
    const row = event.target.closest("li[data-key]");
    return activate(row.querySelector('[data-action="rename"]'), row);
  });
}
</script>`,
    { menu: true, undo: true, ask },
  );
