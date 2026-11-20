import { type DigestDeps, type DigestLink, previewDigest } from "./digest.js";
import { CoreError } from "./errors.js";
import { checkPair, intentExpectation, KEPT_TOOL_STAYS } from "./intent.js";
import type { EventWrite, LinkExpectation } from "./store.js";
import type { IntentPair } from "./tool-store.js";
import type { ToolItem } from "./tools.js";
import type { Intent, Link, LinkPatch, LinkState, OwnerId } from "./types.js";

/** Home's Explore tray: the use cases behind its cards and buttons. */

const DAY_MS = 86_400_000;
/** Cards on the home page, at most. */
export const WORTH_SIZE = 3;
/** How long Skip hides a link (owner ruling on #95). */
export const SNOOZE_MS = 14 * DAY_MS;

export type WorthDeps = DigestDeps;

/**
 * Explore's cards: up to WORTH_SIZE To explore links, the oldest saved first, with at most one
 * focus match leading. Leaves out the links in `suggestions`: the caller passes the suggestions it
 * shows on the shelf. Reads only, so the same cards show until one is decided.
 */
export async function worthALook(
  deps: WorthDeps,
  owner: OwnerId,
  suggestions: readonly ToolItem[],
): Promise<{ links: DigestLink[] }> {
  const shown = new Set(suggestions.map((s) => s.link.id));
  return previewDigest(deps, owner, WORTH_SIZE, shown, 1);
}

export type Snooze = { until: Date };

/** Skip: snoozes the link for SNOOZE_MS and records `not_now`. */
export async function snoozeLink(deps: WorthDeps, owner: OwnerId, id: string): Promise<Snooze> {
  const now = deps.now();
  const link = await deps.store.get(owner, id);
  if (!link) throw new CoreError("not_found", "That link is gone. Reload the page.");
  if (link.state !== "active") throw new CoreError("conflict", ALREADY_ARCHIVED);
  if (link.snoozedUntil !== null && link.snoozedUntil > now) {
    throw new CoreError("conflict", ALREADY_PUT_OFF);
  }
  const until = new Date(now.getTime() + SNOOZE_MS);
  const expected = { state: link.state, snoozedUntil: link.snoozedUntil };
  await changeIf(deps, owner, id, expected, { snoozedUntil: until }, ALREADY_PUT_OFF, [
    { record: "not_now", at: now },
  ]);
  return { until };
}

const ALREADY_PUT_OFF = "This link is already put off. Reload.";
export const ALREADY_ARCHIVED = "This link is already archived. Reload.";

export async function unsnoozeLink(
  deps: WorthDeps,
  owner: OwnerId,
  id: string,
  snooze: Snooze,
): Promise<void> {
  await changeIf(
    deps,
    owner,
    id,
    { snoozedUntil: snooze.until },
    { snoozedUntil: null },
    undefined,
    [{ unrecord: "not_now", at: new Date(snooze.until.getTime() - SNOOZE_MS) }],
  );
}

/** What a state action replaced and what it left, and when it ran; Undo sends all three back. */
export type StateChange = {
  before: { state: LinkState; snoozedUntil: Date | null };
  after: { state: LinkState };
  at: Date;
};

type StateDeps = Pick<WorthDeps, "store" | "now">;

const beforeOf = (l: Link): StateChange["before"] => ({
  state: l.state,
  snoozedUntil: l.snoozedUntil,
});

async function current(deps: StateDeps, owner: OwnerId, id: string): Promise<Link> {
  const link = await deps.store.get(owner, id);
  if (!link) throw new CoreError("not_found", "That link is gone. Reload the page.");
  return link;
}

/** Archive: active -> archived. */
export async function archiveLink(
  deps: StateDeps,
  owner: OwnerId,
  id: string,
): Promise<StateChange> {
  const link = await current(deps, owner, id);
  if (link.state === "archived") throw new CoreError("conflict", ALREADY_ARCHIVED);
  const at = deps.now();
  await changeIf(deps, owner, id, { state: "active" }, { state: "archived" }, ALREADY_ARCHIVED, [
    { record: "stale", at },
  ]);
  return { before: beforeOf(link), after: { state: "archived" }, at };
}

/** Bring it back: an archived link -> active. A link already active is left as it is. */
export async function bringBackLink(
  deps: StateDeps,
  owner: OwnerId,
  id: string,
): Promise<StateChange> {
  const link = await current(deps, owner, id);
  const at = deps.now();
  if (link.state === "active") return { before: beforeOf(link), after: { state: "active" }, at };
  await changeIf(deps, owner, id, { state: "archived" }, { state: "active" });
  return { before: beforeOf(link), after: { state: "active" }, at };
}

/** Undo of Archive or Bring it back: only while the link matches change.after; restores change.before. */
export async function undoStateChange(
  deps: StateDeps,
  owner: OwnerId,
  id: string,
  change: StateChange,
): Promise<void> {
  // Taking Archive back takes back the event it recorded, found by its own time.
  const events: EventWrite[] =
    change.after.state === "archived" ? [{ unrecord: "stale", at: change.at }] : [];
  await changeIf(deps, owner, id, change.after, change.before, undefined, events);
}

/**
 * What Keep it or Explore it replaced and wrote, and when; Undo sends it back. It holds only the
 * intent pair, so an Undo never touches state or a snooze made in between.
 */
export type IntentChange = { before: IntentPair; after: IntentPair; at: Date };

/** Keep it: the link becomes To keep, as the owner's own word (stated). */
export const keepLink = (deps: StateDeps, owner: OwnerId, id: string): Promise<IntentChange> =>
  setIntent(deps, owner, id, "keep");

/** Explore it: the link becomes To explore, as the owner's own word. A kept tool refuses it. */
export const exploreLink = (deps: StateDeps, owner: OwnerId, id: string): Promise<IntentChange> =>
  setIntent(deps, owner, id, "explore");

async function setIntent(
  deps: StateDeps,
  owner: OwnerId,
  id: string,
  intent: Intent,
): Promise<IntentChange> {
  const link = await current(deps, owner, id);
  if (link.state === "archived") throw new CoreError("conflict", ALREADY_ARCHIVED);
  const after: IntentPair = { intent, intentSource: "stated" };
  const patch = { intent, intentSource: "stated" } as const;
  const result = await deps.store.updateIf(
    owner,
    id,
    { state: "active", ...intentExpectation(patch) },
    patch,
  );
  if (!result) throw new CoreError("not_found", "That link is gone. Reload the page.");
  if (!result.applied) {
    throw new CoreError(
      "conflict",
      result.link.state === "archived" ? ALREADY_ARCHIVED : KEPT_TOOL_STAYS,
    );
  }
  return {
    before: { intent: link.intent, intentSource: link.intentSource },
    after,
    at: deps.now(),
  };
}

/**
 * Undo of Keep it or Explore it: only while the link's intent still is change.after; restores
 * change.before and nothing else. Both pairs must be ones the store can hold.
 */
export async function undoIntentChange(
  deps: StateDeps,
  owner: OwnerId,
  id: string,
  change: IntentChange,
): Promise<void> {
  const before = checkPair(change.before);
  const after = checkPair(change.after);
  await changeIf(
    deps,
    owner,
    id,
    { intent: after.intent, intentSource: [after.intentSource], ...intentExpectation(before) },
    before,
  );
}

/**
 * The owner's own reason for saving the link, recorded as "asked". It fills a missing why or
 * replaces an agent's guess, never a reason the owner gave. Blank text is refused.
 */
export async function tellWhy(
  deps: Pick<WorthDeps, "store">,
  owner: OwnerId,
  id: string,
  text: string,
): Promise<Link> {
  const why = text.trim();
  if (why === "") throw new CoreError("invalid_input", "Write the reason first.");
  return changeIf(
    deps,
    owner,
    id,
    { whySource: [null, "inferred"] },
    { why: { text: why, source: "asked" } },
    "This link already has a reason. Reload.",
  );
}

const CHANGED_SINCE = "That link was changed since, so it stays as it is. Reload the page.";

/** A missing or foreign link is not_found; one that no longer matches is a `conflict`. */
export async function changeIf(
  deps: Pick<WorthDeps, "store">,
  owner: OwnerId,
  id: string,
  expected: LinkExpectation,
  patch: LinkPatch,
  conflict = CHANGED_SINCE,
  events?: EventWrite[],
): Promise<Link> {
  const result = await deps.store.updateIf(owner, id, expected, patch, events);
  if (!result) throw new CoreError("not_found", "That link is gone. Reload the page.");
  if (!result.applied) throw new CoreError("conflict", conflict);
  return result.link;
}
