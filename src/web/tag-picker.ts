const REMOVE_TAG = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
/** The longest tag name or key a dialog carries: the field's limit and the door's cap. */
export const EDIT_MAX_TAG_TEXT = 200;
const SUGGESTIONS_MAX = 6;

/**
 * The tag fieldset the Edit link and Save dialogs share: the chips, the field with its label and
 * the suggestions. `id` is the field's, so each dialog's label points at its own.
 */
export const tagFieldset = (id: string, legend: string) => `<fieldset class="edit-tags">
<legend>${legend}</legend>
<ul class="edit-chips"></ul>
<label for="${id}">Add a tag</label>
<input id="${id}" class="edit-tag-input" autocomplete="off" maxlength="${EDIT_MAX_TAG_TEXT}" enterkeyhint="done">
<ul class="edit-suggest" hidden></ul>
</fieldset>`;

/**
 * The tag picker's script, written into a dialog's own block. `tagPicker(fieldset, clearError)`
 * wires a `tagFieldset` and returns its state:
 * - `load(held)` shows the tags a link holds (`opened` keeps them, as the Save's "seen") and
 *   empties the field and the suggestion names; `loadNames()` reads the owner's tag names from
 *   `/tags/names` for suggestions only, and an earlier read that comes late is dropped
 *   (`dropNames()` drops it at once). It still works without them.
 * - Enter adds the typed name and does not send the form; a suggestion adds its name; the x
 *   removes a chip. Each of these calls `clearError()` first, as an edit does. `flush()` adds the
 *   text left in the field, which a Save sends too.
 * - A tag the link held comes back as it was, so a guess stays a guess; a new one is stated and
 *   takes the catalog's spelling of its key.
 * - `disable(true)` turns the field, the chips' x and the suggestions off while a Save is out.
 * - `tags` and `opened` are the dialog's tags now and as it opened them.
 */
export const TAG_PICKER = `const tagPicker = (fieldset, clearError) => {
  const tagList = fieldset.querySelector(".edit-chips");
  const tagField = fieldset.querySelector(".edit-tag-input");
  const suggestList = fieldset.querySelector(".edit-suggest");
  let tags = [];
  let openedTags = [];
  let catalog = [];
  let namesTurn = 0;
  let disabled = false;
  const keyOf = (name) => name.trim().replace(/\\s+/g, " ").toLowerCase();
  const clear = (list) => {
    while (list.firstChild) list.removeChild(list.firstChild);
  };
  const listItem = (list, child) => {
    const item = document.createElement("li");
    item.append(child);
    list.append(item);
    return item;
  };
  const renderTags = () => {
    clear(tagList);
    for (const t of tags) {
      const name = document.createElement("span");
      name.textContent = t.name;
      const item = listItem(tagList, name);
      item.className = "edit-tag";
      if (t.source === "inferred") {
        const guess = document.createElement("span");
        guess.className = "edit-tag-guess";
        guess.textContent = " (a guess)";
        item.append(guess);
      }
      const remove = document.createElement("button");
      remove.setAttribute("type", "button");
      remove.className = "edit-tag-remove";
      remove.setAttribute("aria-label", "Remove " + t.name);
      remove.setAttribute("data-key", t.key);
      remove.innerHTML = ${JSON.stringify(REMOVE_TAG)};
      remove.disabled = disabled;
      item.append(remove);
    }
  };
  // Up to ${SUGGESTIONS_MAX} catalog names containing the typed text and not on the link yet, those that start with it first.
  const showSuggestions = () => {
    clear(suggestList);
    const text = keyOf(tagField.value);
    const have = new Set(tags.map((t) => t.key));
    const hits = text === "" ? [] : catalog.filter((n) => keyOf(n).includes(text) && !have.has(keyOf(n)));
    const first = hits.filter((n) => keyOf(n).startsWith(text));
    const rest = hits.filter((n) => !keyOf(n).startsWith(text));
    for (const name of [...first, ...rest].slice(0, ${SUGGESTIONS_MAX})) {
      const button = document.createElement("button");
      button.setAttribute("type", "button");
      button.className = "edit-suggest-item";
      button.textContent = name;
      button.disabled = disabled;
      listItem(suggestList, button);
    }
    suggestList.hidden = !suggestList.firstChild;
  };
  // Adds the typed name, unless its key is already there. A tag the card opened with comes back as
  // it was, so a guess stays a guess.
  const addTag = (raw) => {
    const name = raw.trim().replace(/\\s+/g, " ");
    const key = keyOf(name);
    if (name === "" || tags.some((t) => t.key === key)) {
      tagField.value = "";
      return;
    }
    const before = openedTags.find((t) => t.key === key);
    const known = catalog.find((n) => keyOf(n) === key);
    tags.push(before ? { ...before } : { key, name: known || name, source: "stated" });
    tagField.value = "";
  };
  tagList.addEventListener("click", (event) => {
    const remove = event.target.closest(".edit-tag-remove");
    if (!remove || remove.disabled) return;
    tags = tags.filter((t) => t.key !== remove.getAttribute("data-key"));
    renderTags();
    showSuggestions();
    tagField.focus();
  });
  suggestList.addEventListener("click", (event) => {
    const item = event.target.closest(".edit-suggest-item");
    if (!item || item.disabled) return;
    clearError();
    addTag(item.textContent);
    renderTags();
    showSuggestions();
    tagField.focus();
  });
  tagField.addEventListener("input", showSuggestions);
  // Enter adds the typed name; it does not send the form.
  tagField.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (disabled || event.isComposing) return;
    clearError();
    addTag(tagField.value);
    renderTags();
    showSuggestions();
  });
  // On a phone the keyboard covers the sheet's lower half: bring the field into view.
  tagField.addEventListener("focus", () => {
    if (tagField.scrollIntoView) tagField.scrollIntoView({ block: "center" });
  });
  return {
    get tags() {
      return tags;
    },
    get opened() {
      return openedTags;
    },
    load(held) {
      openedTags = Array.isArray(held) ? held : [];
      tags = openedTags.map((t) => ({ ...t }));
      tagField.value = "";
      catalog = [];
      renderTags();
      showSuggestions();
    },
    async loadNames() {
      const turn = ++namesTurn;
      const res = await fetch("/tags/names", { redirect: "manual" }).catch(() => null);
      const got = res && res.status === 200 ? await res.json().catch(() => null) : null;
      if (turn !== namesTurn) return;
      catalog = got && Array.isArray(got.names) ? got.names.filter((n) => typeof n === "string") : [];
      showSuggestions();
    },
    dropNames() {
      namesTurn++;
    },
    flush() {
      addTag(tagField.value);
      renderTags();
    },
    disable(off) {
      disabled = off;
      tagField.disabled = off;
      for (const c of fieldset.querySelectorAll(".edit-tag-remove, .edit-suggest-item")) c.disabled = off;
    },
  };
};`;
