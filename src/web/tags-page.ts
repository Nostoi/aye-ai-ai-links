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
  return `<li class="tag" data-key="${escapeHtml(t.key)}" data-kind="${t.kind}" data-guess="${guess}" data-status="${done ? "done" : "active"}">
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

/** The owner's tags: pin one to make it a space, and set its kind, status and color. */
export const tagsPage = ({ tags }: { tags: Tag[] }) =>
  page(
    "Tags · Aye-AI-AI Links",
    `<main class="tags">
<h1>Tags</h1>
<p class="lead">Pinned tags are your spaces on the home page. Each one keeps its color everywhere.</p>
<p id="tags-error" role="alert"></p>
${tags.length === 0 ? "<p>No tags yet. Your AI adds tags when it saves a link.</p>" : `<ul class="tag-list" id="tags">\n${tags.map(tagItem).join("\n")}\n</ul>`}
</main>`,
    { menu: true, undo: true },
  );
