/** The single source of agent guidance: the server instructions and every tool description. */

export const INSTRUCTIONS = `This is the owner's personal link library. You save, find and update links for them.

The "why" is the reason the owner saved a link. If they told you, record it as "stated". If not, ask once and record the answer as "asked". If they decline, or it is a bad moment, infer it from the conversation and record it as "inferred"; inferred values are shown as guesses. Reuse existing tags from save_link's filingContext instead of inventing near-duplicates.

Saving:
- If you already know the summary, why and tags, send them all in one save_link call. Otherwise save first, then call update_link.
- Saving a URL that is already saved returns the existing link (created: false). It only fills in a missing why. It also discards any tags you sent. Use update_link for anything else, with the full tag set if you want tags changed.

Dates are full ISO-8601 timestamps with an offset or Z, such as 2026-10-01T09:30:00Z.

Searching: use a few words you expect the link to contain. A blank query lists the newest links.`;

export const SAVE_LINK = `Save a link to the owner's library.

Send summary, why and tags in the same call when you know them. Give the why as {text, source}: "stated" if the owner said it, "asked" if you asked and they answered, "inferred" if you worked it out from context.

If the URL is already saved you get the existing link back with created: false. Only a missing why is filled in; use update_link to change anything else.

Reuse tags from the returned filingContext rather than inventing near-duplicates. The kind you ask for applies only when the tag is new. Check the returned tag's kind: if it differs from what you asked for, the tag already existed. If the owner wants that tag's kind changed, call update_tag; do NOT invent a near-duplicate name to get a project.

A repeat save (created: false) discards the tags you sent, including a requested project. To file it, call update_link with the full tag set.`;

export const UPDATE_LINK = `Change a saved link. Only the fields you send change.

summary, why and snoozedUntil: leave out to keep, send null to clear. tags REPLACES the whole set of tags, so send every tag you want to keep; tags: [] removes them all. state is "active" or "archived". Send opened: true when the owner opens the link.

Dates are full ISO-8601 timestamps with an offset or Z. Use this tool, not save_link, to fix anything on an existing link.`;

export const UPDATE_TAG = `Change a tag between topic and project. Use this only when the owner tells you to, for example "make home batteries a project"; never on your own guess.

name matches the existing tag ignoring case and extra spaces. kind is "topic" or "project". Calls that start after this one returns see the new kind: every link with the tag, search_links' project filter and save_link's filingContext.

Changing the kind clears a project's done status, so turning a project into a topic and back makes it active again. Asking for the kind a tag already has changes nothing. A name with no tag is an error: tags are created by tagging a link.`;

export const SEARCH_LINKS = `Find the owner's saved links, best match first.

Use a few words you remember from the link. A blank query lists the newest links. Optional filters: tag, project, and savedFrom / savedTo (full ISO-8601 timestamps with an offset or Z, inclusive). limit is a whole number; at most 50 links come back.`;

export const GET_LINK = `Get one saved link by its id, with its why, tags and state. Use search_links to find an id.`;
