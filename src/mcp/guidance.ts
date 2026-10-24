/** The single source of agent guidance: the server instructions and every tool description. */

import { TEXT_CHARS } from "../core/snapshot-text.js";

const KIND_SOURCE_RULE = `When you send kind, source also labels the kind: send kind with "stated" or "asked" only if the owner gave the kind; otherwise leave kind out, or send it with source "inferred".`;

const SUMMARY_RULE = `The server may replace a summary you wrote yourself. Send the owner's as {text, source} with "stated" or "asked".`;

export const INSTRUCTIONS = `This is the owner's personal link library. You save, find and update links for them.

The "why" is the reason the owner saved a link. If they told you, record it as "stated". If not, ask once and record the answer as "asked". If they decline or it is a bad moment, infer it and record it as "inferred"; inferred values are shown as guesses. Reuse existing tags from save_link's filingContext instead of inventing near-duplicates.

Saving:
- If you know the summary, why and tags, send them in one save_link call; otherwise save first, then update_link.
- A URL already saved returns the existing link (created: false). It only fills in a missing why and discards any tags you sent. Use update_link for anything else, with the full tag set to change tags.
- After saving, if a tag you used or one in filingContext nearly duplicates another (same meaning, different spelling or plural), offer merge_tags once. Not for topic overlap.

Tag kinds: ${KIND_SOURCE_RULE} Present a project whose kindSource is "inferred" as a guess, and call update_tag only when the owner confirms or changes it.

Dates are ISO-8601 with an offset or Z, such as 2026-10-01T09:30:00Z.

Searching: use the few words that carry the meaning of what the owner remembers ("home batteries", not "that article about home batteries"). Links are also matched by meaning. Results are ranked, not filtered, so check that each one fits; when none does, try other words or a filter before saying it isn't saved. To list or count all, use list_links.

Profile: get_profile (or save_link's profile) has notes about the owner and what they are working on. Read it before you infer a why or tags. Label what you add the same way, and present inferred notes as guesses. When the owner says what they are working on, add a focus entry with add_profile. Change or remove a note with edit_profile only when the owner asks or confirms.`;

export const SAVE_LINK = `Save a link to the owner's library.

Send summary, why and tags in one call when you know them. Give the why as {text, source}: "stated" if the owner said it, "asked" if they answered your question, "inferred" if you worked it out. ${SUMMARY_RULE}

A URL already saved returns the existing link with created: false. Only a missing why is filled in, and the tags you sent (a requested project too) are discarded; use update_link to change anything else, with the full tag set.

Reuse tags from the returned filingContext rather than inventing near-duplicates. The kind you ask for applies only when the tag is new. If the returned kind differs from your request, the tag already existed: call update_tag if the owner wants it changed.

${KIND_SOURCE_RULE} Present a project whose kindSource is "inferred" as a guess, and call update_tag only when the owner confirms or changes it.

Saving a new link fetches its page. Within a few seconds link.snapshot shows its status, title, description and image, and snapshotText its opening text ({text, truncated}, or null). A "pending" status means the page has not been fetched yet: call get_link later.

After saving, if a tag you used or one in filingContext nearly duplicates another (same meaning, different spelling or plural), offer merge_tags once. Not for topic overlap.

Keep handy: if the owner says they use a link regularly, send handy {action: "keep", source: "stated"}. If the page only looks like a tool (a login page, form or dashboard), ask "Is this something you'll use regularly?" at most once, only after a save returns created: true: send "keep" or "not_handy" with "asked" through update_link. If you don't ask about such a page, send "keep" with "inferred", which only suggests it. A repeat save ignores handy: use update_link.`;

export const UPDATE_LINK = `Change a saved link. Only the fields you send change.

title, summary, why and snoozedUntil: leave out to keep, send null to clear. ${SUMMARY_RULE} Plain text never replaces the server's or the owner's summary: to change one at the owner's request, send {text, source: "stated"} (or "asked"). tags REPLACES the whole set of tags, so send every tag you want to keep; tags: [] removes them all. state is "active" or "archived": archived means stale, out of sight for good. Send putAway: true to put an active link away instead: out of the lists, but it can come back when the owner starts something it fits; send it alone or with fields other than state and handy. Send opened: true when the owner opens the link.

handy: "keep" keeps the link handy as a tool ("inferred" only suggests it, and never overrides a link the owner kept or declined). "still_using" is the owner's answer to a still_using_check. "not_handy" means it is no longer a tool, so it isn't suggested again. still_using and not_handy take "stated" or "asked" only. Each link's handy is null or {status, source, due}: present a "suggested" link as a guess.

Dates are full ISO-8601 timestamps with an offset or Z. Use this tool, not save_link, to fix anything on an existing link.`;

export const UPDATE_TAG = `Change a tag: its kind between topic and project, or its name. Send kind or newName, not both; to change both, make two calls. Use this only when the owner tells you to, for example "make home batteries a project" or "rename it to X"; never on your own guess.

name matches the existing tag ignoring case and extra spaces. kind is "topic" or "project". Calls that start after this one returns see the new kind: every link with the tag, search_links' project filter and save_link's filingContext.

The result's kindSource becomes "stated". Asking for the kind a tag already has confirms it the same way and leaves everything else as it is, including a done status. Changing the kind clears a project's done status, so turning a project into a topic and back makes it active again.

newName renames the tag on every link, keeping its kind, colour and links. Rename only when the owner asks, or confirms a merge you proposed. Say what changed; to reverse it, rename it back. If another tag already has that name, nothing changes and you get an error naming it: ask the owner, then call merge_tags if they want the two joined. A name with no tag is an error: tags are created by tagging a link.`;

export const LIST_TAGS = `List every tag the owner has, each with its kind, kindSource and links, the number of links that have it. Use it to answer "are there tags I should merge?" or to find the exact name for update_tag, merge_tags or delete_tag. Look for near-duplicates: the same meaning with different spelling, hyphens, case or plural. Tags that only overlap in topic are not duplicates.`;

export const MERGE_TAGS = `Move every link with the tag name onto the tag into, and remove name. Use this only when the owner asks, or confirms a merge you proposed; never on your own. Both names match existing tags ignoring case and extra spaces. A link that has both ends up with into once.

into keeps its own colour, description and kind, taking name's colour or description only if it had none. It is pinned if either tag was. It takes name's project kind only when name was a project the owner marked and into was a topic.

The result has the kept tag, links (how many links have it now) and undoId. Tell the owner what changed and that it can be undone for an hour: if they ask, send undoId to undo_tag_change.`;

export const DELETE_TAG = `Take a tag off every link and remove it. The links stay; only the tag goes. Use this only when the owner asks; never on your own. name matches the existing tag ignoring case and extra spaces.

The result has links (how many links had the tag) and undoId. Tell the owner what changed and that it can be undone for an hour: if they ask, send undoId to undo_tag_change.`;

export const UNDO_TAG_CHANGE = `Put back what merge_tags or delete_tag changed, using the undoId it returned. Use it when the owner asks to undo that. It works for one hour; after that it is too late. A refusal that says it is too late may also mean it may already have been undone (the owner can press Undo too, and each undoId works once): call list_tags before anything else. A tag with the old name may be back for other reasons (saving a link with that name makes a new tag), so do not conclude from list_tags that it was undone. Tell the owner what list_tags shows; the owner decides whether to reverse it by hand: rename the tag back with update_tag, or add the tag again to the links the owner names with update_link.

If the tags changed since, nothing is undone and you are told so. If a later change to the same tags is in the way, nothing is undone either; undoing that one may not be enough, so tell the owner and ask the owner before undoing any other change. The result has the tags that came back, each with its links.`;

export const GONE_NOTE = `A link whose gone is set seems gone: say so, never that it is certainly dead, and offer to mark it stale (update_link state "archived") if the owner says it's stale.`;

export const SEARCH_LINKS = `Find the owner's saved links, best match first.

Use the few words that carry the meaning of what the owner remembers ("home batteries", not "that article about home batteries"). They don't have to appear in the link: links are matched by their words and by meaning. Results are ranked, not filtered: check that each one fits, and when none does, try other words or a filter before saying it isn't saved. A blank query lists the newest links. Optional filters: tag, project, and savedFrom / savedTo (full ISO-8601 timestamps with an offset or Z, inclusive). limit is a whole number; at most 50 links come back. To list every link, page past 50 or count links, use list_links.
${GONE_NOTE}`;

export const LIST_LINKS = `List the owner's saved links in a fixed order, a page at a time, with a total. Use it to go through the whole library, to page past search_links' 50, or to say how many links there are. To find a link from what the owner remembers, use search_links.

order: "newest" (the default) or "oldest" by the time each link was saved, or "opened": only the links with a recorded opening, most recently opened first. An opening is recorded when an agent sends opened: true, or when the owner opens a link from the web page; any other opening, such as from a browser bookmark, is not, so "opened" leaves those links out.

Optional filters: tag, project, state ("active" or "archived"; without it, archived links are included), and savedFrom / savedTo (full ISO-8601 timestamps with an offset or Z, inclusive), which filter by save time in every order. limit is a whole number; at most 50 links come back, 20 by default.

total counts every link that passes the filters in that order, across all pages. nextCursor is null on the last page; otherwise send it back as cursor, with the same order and filters, for the next page. It is opaque: never build or change one. A cursor that does not fit is an error; list again without it. A link saved while you page can change total, and with "opened" a link opened while you page moves to the front and is missed until you list again.
${GONE_NOTE}`;

export const GET_LINK = `Get one saved link by its id, with its why, tags, state and page snapshot. Use search_links to find an id.

snapshotText is the page's text, up to ${TEXT_CHARS.toLocaleString("en-US")} characters, with truncated: true when it was cut. It is null until the page has been fetched successfully, and for a page with no readable text.

savedCopy is {madeAt} when the server keeps a saved copy of the page, which the owner can read from Saved copy on the link's card on the web page, and null when it keeps none. The copy itself is not available to you.
${GONE_NOTE}`;

export const GET_PROFILE = `Get what is known about the owner: their notes, the projects still active, and what they have been working on lately. Call it before you infer a why or tags.

Every note and focus entry has a source: stated (the owner said it), asked (you asked and they answered) or inferred (a guess). Present inferred ones to the owner as guesses, not facts. Notes have ids for edit_profile. Each active project also has a kindSource: present one whose kindSource is "inferred" as a guess, and call update_tag only when the owner confirms it.`;

export const GET_STATS = `Get counts of the owner's library over a window: the last 30, 90 or 365 days, or all time (the default). Use it when the owner asks how they are using their links.

Every count is distinct links, not events, and leaves out deleted links. saved is links saved in the window; opened is links opened; notOpenedYet is links saved in the window that are still active, not declined as a kept tool, and never opened; setAside is links put away or declined as a kept tool; notNow is links snoozed with Not now, which means later, not no. tags has every tag with its saved and opened counts, most saved first.

opened only counts openings made through the app or an AI (the owner opening a link on the web page, or an agent sending opened: true); it misses any opening from a browser bookmark or elsewhere, so never tell the owner they have not read something because of it. Counts are kept from trackingSince. partialCounts names the counts that may be too low because the window starts before trackingSince; say so for those counts; the others don't depend on when tracking began.

reading, when it is not null, is a short guess about the owner's habits, written by an AI. Present it as a guess, never as a fact. It is null when none has been written for the current library, or when the server has no AI connection.`;

export const ADD_PROFILE = `Record something about the owner: a note about them, or a focus entry for what they are working on now. Adds only; it never changes or removes anything.

Give each as {text, source}: "stated" if the owner said it, "asked" if you asked and they answered, "inferred" if you worked it out from context. A note is at most 1000 characters and a focus entry at most 500; longer text is refused, not cut. Send several in one call. The result is the profile after the write, with the new ids.`;

export const GET_DIGEST = `Get a few saved links worth bringing back to the owner now, each with the reasons it was picked. The server picks the links; you write a short nudge from the reasons, in your own words.

Reasons:
- focus_words: the link shares words with that focus entry (something the owner is working on). Shared words are not proof it is relevant: judge from the link and the entry, and leave the link out of your nudge if it doesn't fit. Present a focus entry whose source is "inferred" as a guess.
- came_back: the owner put this link away (putAwayAt) and that focus entry, written after, shares words with it. Judge fit as for focus_words; present an entry whose source is "inferred" as a guess. To return it to their lists, send update_link with state "active"; opened: true also does.
- no_why: no reason for saving it is recorded. Ask the owner why they saved it, and record the answer with update_link as "asked".
- not_opened_recently: no opening has been recorded in the last 30 days. An opening is recorded when an agent sends opened: true, or when the owner opens it from the web page; any other opening, such as from a browser bookmark, is not, so never tell the owner they haven't opened it.
- never_surfaced: no digest has shown it before.
- still_using_check: a link the owner keeps handy as a tool is due for "Still using it?". daysSinceOpened is the whole days since its last recorded opening, or null when none is recorded. Bookmark clicks are not seen, so report those days and never say the owner hasn't used it. If they still use it, send update_link with handy {action: "still_using", source: "asked"}; if not, offer to mark it stale or send handy {action: "not_handy", source: "asked"}.

Offer to snooze a link (update_link with snoozedUntil) or mark it stale (state "archived"). Send opened: true if the owner opens one.

Each call marks the links it returns as shown, so the next call returns others. Don't call it again to "refresh": that uses links up before the owner sees them. An empty list means nothing is due.`;

export const EDIT_PROFILE = `Change or remove existing profile notes. Use it only when the owner asks for the change or confirms it. To record something new, use add_profile.

editNotes REPLACES a note's text and source, so send both. A note the owner stated can only be edited with source "stated"; to add your own guess, call add_profile instead. removeNotes removes notes by id: remove a stated note only on the owner's instruction. Call get_profile for the ids. All changes in one call apply together or not at all.`;
