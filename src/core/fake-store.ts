import { createHash, randomUUID } from "node:crypto";
import {
  anyChanged,
  type Changed,
  type Covered,
  changedFields,
  coveredOf,
  extendedPrior,
  holdsWritten,
  sameTags,
} from "./covered-fields.js";
import type { IconBackfillStore, IconCandidate, PreviewLink } from "./icon-backfill-store.js";
import {
  type ImageBytes,
  type ImageEnd,
  type ImageRole,
  type ImageStore,
  imageVersion,
  type LinkImageReader,
  type PendingImage,
  type PictureFit,
  type PictureInfo,
  type ShownPicture,
  type StoredImage,
} from "./image-store.js";
import {
  type CheckCutoffs,
  type CheckWrite,
  type DueCheck,
  type LinkCheck,
  type LinkCheckStore,
  sameCheck,
} from "./link-check-store.js";
import type { LinkEdit, LinkEditStore, UndoOutcome } from "./link-edit-store.js";
import {
  hasConsistentSchedule,
  hasValidIcons,
  MAX_ICON_URLS,
  type SnapshotLease,
  type SnapshotRecord,
  type SnapshotStore,
} from "./snapshot-store.js";
import type { StatsReading, StatsReadingStore } from "./stats-reading-store.js";
import type { StatsEvent, StatsStore } from "./stats-store.js";
import type {
  EventWrite,
  LinkExpectation,
  LinkRemover,
  LinkStore,
  SummaryCandidate,
  SummaryCandidates,
  SurfacedClaim,
} from "./store.js";
import type { LoggedEvent } from "./store-contract.js";
import { receiptsMeet, type TagEditStore, type TagSettings } from "./tag-edit-store.js";
import type { TagSuggestStore } from "./tag-suggest-store.js";
import { strongerSource } from "./tags.js";
import { sameTool, type ToolRecord, type ToolStore, type ToolWrite } from "./tool-store.js";
import type {
  Labelled,
  Link,
  LinkEventKind,
  LinkPatch,
  NewLink,
  OwnerId,
  SnapshotStatus,
  Source,
  SummarySource,
  Tag,
  TagKind,
  TagPatch,
} from "./types.js";

type TagMark = { key: string; source: Source };
/** A merge or delete's receipt, as `tag_changes` holds it: see `SqliteTagEditStore`. */
type TagChange = {
  at: Date;
  removed: Tag;
  aliases: string[];
  address?: string | null;
  kept?: { key: string; before: TagSettings; after: TagSettings; links: string[] };
  links: { id: string; before: TagMark[]; after: TagMark[] }[];
};
const settingsOf = (t: TagSettings): TagSettings => ({
  kind: t.kind,
  kindSource: t.kindSource,
  color: t.color,
  pinned: t.pinned,
  description: t.description,
  projectStatus: t.projectStatus,
});
const sameSettings = (a: TagSettings, b: TagSettings) =>
  JSON.stringify(settingsOf(a)) === JSON.stringify(settingsOf(b));
const marksOf = (link: Link): TagMark[] => link.tags.map(({ key, source }) => ({ key, source }));
const sameTag = (a: Tag, b: Tag) => a.key === b.key && a.name === b.name && sameSettings(a, b);

type ImageStatus = "pending" | "ok" | ImageEnd;
const imageKey = (owner: OwnerId, linkId: string) => JSON.stringify([owner, linkId]);
/** How a fetched picture of this role fits its box. */
const roleFit = (role: ImageRole): PictureFit => (role === "icon" ? "contain" : "cover");

type OwnRecord = ImageBytes & { sha256: string; setAt: Date };
type EditRecord = {
  editId: string;
  /** Which covered fields the edit changed; `prior` and `written` hold their values before and after. */
  changed: Changed;
  prior: Covered;
  written: Covered;
  pictureChanged: boolean;
  priorPicture: OwnRecord | null;
  writtenSha: string | null;
};
/** What a delete, Undo and purge do to the link's saved copy, as SQLite does in the same step. */
type CopyHooks = {
  removeForDelete(owner: OwnerId, id: string, at: Date): void;
  restoreForUndo(owner: OwnerId, id: string, deletedAt: Date): void;
  /** The copy is not absent and not a 0-byte tombstone, so its files may still exist. */
  holdsFiles(owner: OwnerId, id: string): boolean;
  purged(owner: OwnerId, id: string): void;
};
const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stored = (own: OwnRecord): StoredImage => ({
  contentType: own.contentType,
  bytes: new Uint8Array(own.bytes),
  version: imageVersion(own.sha256),
});

const LINK_EVENT_KINDS: readonly string[] = ["opened", "put_away", "stale", "not_now", "not_handy"];

/** Whether the link still matches every field `expected` names (see `LinkStore.updateIf`). */
function matchesExpectation(found: Link, expected: LinkExpectation): boolean {
  return (
    (expected.state === undefined || found.state === expected.state) &&
    (expected.snoozedUntil === undefined ||
      (found.snoozedUntil?.getTime() ?? null) === (expected.snoozedUntil?.getTime() ?? null)) &&
    (expected.putAwayAt === undefined ||
      (found.putAwayAt?.getTime() ?? null) === (expected.putAwayAt?.getTime() ?? null)) &&
    (expected.whySource === undefined || expected.whySource.includes(found.why?.source ?? null)) &&
    (expected.summary === undefined || found.summary === expected.summary) &&
    (expected.summarySource === undefined || expected.summarySource.includes(found.summarySource))
  );
}

/** A tag pair as one string, the keys sorted so either order gives the same one. */
const pairKey = (a: string, b: string): string => (a < b ? `${a}\0${b}` : `${b}\0${a}`);
const pairOf = (p: string): [string, string] => p.split("\0") as [string, string];

/** In-memory LinkStore for tests; honours the same contracts as the real store. */
export class FakeStore
  implements
    LinkStore,
    LinkRemover,
    SnapshotStore,
    ToolStore,
    LinkCheckStore,
    ImageStore,
    LinkImageReader,
    LinkEditStore,
    IconBackfillStore,
    SummaryCandidates,
    StatsStore,
    StatsReadingStore,
    TagEditStore,
    TagSuggestStore
{
  private snapshots = new Map<OwnerId, Map<string, SnapshotRecord>>();
  /** The lease token of each snapshot, by owner then link id; absent means 0. */
  private tokens = new Map<OwnerId, Map<string, number>>();
  private links = new Map<OwnerId, Map<string, Link>>();
  private hidden = new Map<OwnerId, Map<string, { link: Link; at: Date }>>();
  private tags = new Map<OwnerId, Map<string, Tag>>();
  /** Old key to the live key it reaches, by owner. Every value is a live key: actions keep it so. */
  private aliases = new Map<OwnerId, Map<string, string>>();
  private tagChanges = new Map<OwnerId, Map<string, TagChange>>();
  /** Dismissed tag pairs as `pairKey`, by owner. */
  private dismissals = new Map<OwnerId, Set<string>>();
  /** Each link's image status, and its stored image, by `imageKey`. */
  private imageStates = new Map<string, { status: ImageStatus }>();
  private storedImages = new Map<string, StoredImage & { role: ImageRole }>();
  /** The owner's pictures and each link's last edit record, by `imageKey`. */
  private ownerImages = new Map<string, OwnRecord>();
  private editRecords = new Map<string, EditRecord>();
  private toolRows = new Map<OwnerId, Map<string, ToolRecord>>();
  private checkRows = new Map<OwnerId, Map<string, LinkCheck>>();
  private copies: CopyHooks | null = null;
  /** The event log, as `link_events` holds it. */
  private events: {
    owner: OwnerId;
    linkId: string;
    kind: LinkEventKind;
    at: Date;
    backfilled: boolean;
  }[] = [];
  private nextId = 1;
  private readonly since: Date;
  private readings = new Map<OwnerId, StatsReading>();

  constructor(options: { trackingSince?: Date } = {}) {
    this.since = options.trackingSince ?? new Date(0);
  }

  private owned(owner: OwnerId): Map<string, Link> {
    let m = this.links.get(owner);
    if (!m) {
      m = new Map();
      this.links.set(owner, m);
    }
    return m;
  }

  private catalogOf(owner: OwnerId): Map<string, Tag> {
    let m = this.tags.get(owner);
    if (!m) {
      m = new Map();
      this.tags.set(owner, m);
    }
    return m;
  }

  private ensureTags(owner: OwnerId, tags: Link["tags"]): void {
    const catalog = this.catalogOf(owner);
    for (const t of tags) {
      if (!catalog.has(t.key)) {
        catalog.set(t.key, {
          key: t.key,
          name: t.name,
          kind: t.kind,
          kindSource: t.kindSource,
          color: null,
          pinned: false,
          description: null,
          projectStatus: null,
        });
      }
    }
  }

  private view(owner: OwnerId, link: Link): Link {
    const catalog = this.catalogOf(owner);
    const out = structuredClone(link);
    const s = this.snapshots.get(owner)?.get(link.id);
    out.snapshot = s
      ? {
          status: s.status,
          fetchedAt: s.fetchedAt && new Date(s.fetchedAt),
          title: s.title,
          description: s.description,
          imageUrl: s.imageUrl,
        }
      : null;
    for (const t of out.tags) {
      const entry = catalog.get(t.key);
      t.name = entry?.name ?? t.name;
      t.kind = entry?.kind ?? t.kind;
      t.kindSource = entry?.kindSource ?? t.kindSource;
    }
    return out;
  }

  /** Removes the link, hidden or not, and everything the store keeps for it, as the table's ON DELETE CASCADE does. */
  private cascade(owner: OwnerId, id: string): void {
    const key = imageKey(owner, id);
    this.owned(owner).delete(id);
    this.hidden.get(owner)?.delete(id);
    this.snapshots.get(owner)?.delete(id);
    this.tokens.get(owner)?.delete(id);
    this.toolRows.get(owner)?.delete(id);
    this.checkRows.get(owner)?.delete(id);
    this.events = this.events.filter((e) => e.owner !== owner || e.linkId !== id);
    for (const perLink of [
      this.imageStates,
      this.storedImages,
      this.ownerImages,
      this.editRecords,
    ]) {
      perLink.delete(key);
    }
    this.copies?.purged(owner, id);
  }

  async insertIfAbsent(owner: OwnerId, link: NewLink) {
    for (const [id, entry] of this.hidden.get(owner) ?? []) {
      if (entry.link.urlKey === link.urlKey) this.cascade(owner, id);
    }
    const mine = this.owned(owner);
    for (const existing of mine.values()) {
      if (existing.urlKey === link.urlKey) {
        return { link: this.view(owner, existing), created: false };
      }
    }
    this.ensureTags(owner, link.tags);
    const stored: Link = { ...structuredClone(link), id: `link-${this.nextId++}`, snapshot: null };
    mine.set(stored.id, stored);
    this.snapshotsOf(owner).set(stored.id, {
      status: "pending",
      attempts: 0,
      nextFetchAt: new Date(link.savedAt),
      fetchedAt: null,
      title: null,
      description: null,
      imageUrl: null,
      iconUrls: [],
      text: null,
      lastError: null,
    });
    return { link: this.view(owner, stored), created: true };
  }

  private snapshotsOf(owner: OwnerId): Map<string, SnapshotRecord> {
    let m = this.snapshots.get(owner);
    if (!m) {
      m = new Map();
      this.snapshots.set(owner, m);
    }
    return m;
  }

  async dueSnapshots(now: Date, limit: number) {
    const due: { owner: OwnerId; linkId: string; at: number }[] = [];
    for (const [owner, mine] of this.snapshots) {
      for (const [linkId, s] of mine) {
        const at = s.nextFetchAt?.getTime();
        if (at !== undefined && at <= now.getTime() && ["pending", "retrying"].includes(s.status)) {
          due.push({ owner, linkId, at });
        }
      }
    }
    due.sort((a, b) => a.at - b.at);
    return due.slice(0, limit).map(({ owner, linkId }) => ({ owner, linkId }));
  }

  async leaseSnapshot(
    owner: OwnerId,
    linkId: string,
    now: Date,
    until: Date,
  ): Promise<SnapshotLease | null> {
    if (until.getTime() <= now.getTime()) throw new RangeError("A lease must end after it starts.");
    const s = this.snapshots.get(owner)?.get(linkId);
    const due = s?.nextFetchAt && s.nextFetchAt.getTime() <= now.getTime();
    if (!s || !due || !["pending", "retrying"].includes(s.status)) return null;
    s.nextFetchAt = new Date(until);
    s.attempts += 1;
    const url = (this.owned(owner).get(linkId) ?? this.hidden.get(owner)?.get(linkId)?.link)?.url;
    if (url === undefined) throw new Error(`Snapshot ${linkId} has no link`);
    return { url, attempts: s.attempts, claim: this.bumpToken(owner, linkId) };
  }

  async recordSnapshot(owner: OwnerId, linkId: string, claim: number, result: SnapshotRecord) {
    const mine = this.snapshotsOf(owner);
    if (!mine.has(linkId) || this.tokenOf(owner, linkId) !== claim) return false;
    if (!hasConsistentSchedule(result) || !hasValidIcons(result)) return false;
    mine.set(linkId, structuredClone(result));
    const key = imageKey(owner, linkId);
    if ((result.imageUrl ?? result.iconUrls[0] ?? null) !== null) {
      this.imageStates.set(key, { status: "pending" });
    } else if (result.fetchedAt !== null) {
      this.imageStates.set(key, { status: "none" });
    } else {
      this.imageStates.delete(key);
    }
    if (result.imageUrl !== null && this.storedImages.get(key)?.role === "icon") {
      this.storedImages.delete(key);
    }
    this.bumpToken(owner, linkId);
    return true;
  }

  async releaseSnapshot(owner: OwnerId, linkId: string, claim: number, now: Date) {
    const s = this.snapshots.get(owner)?.get(linkId);
    if (!s || this.tokenOf(owner, linkId) !== claim) return false;
    if (!["pending", "retrying"].includes(s.status)) return false;
    s.attempts -= 1;
    s.nextFetchAt = new Date(now);
    this.bumpToken(owner, linkId);
    return true;
  }

  private tokenOf(owner: OwnerId, linkId: string): number {
    return this.tokens.get(owner)?.get(linkId) ?? 0;
  }

  private bumpToken(owner: OwnerId, linkId: string): number {
    let m = this.tokens.get(owner);
    if (!m) {
      m = new Map();
      this.tokens.set(owner, m);
    }
    const next = this.tokenOf(owner, linkId) + 1;
    m.set(linkId, next);
    return next;
  }

  /** Called by the saved copies built on this store, so a delete, restore and purge reach them. */
  attachCopies(copies: CopyHooks): void {
    this.copies = copies;
  }

  /** A deleted link moves out of `links`, so it is out of every read. */
  async markDeleted(owner: OwnerId, id: string, at: Date): Promise<boolean> {
    const link = this.owned(owner).get(id);
    if (!link) return false;
    this.owned(owner).delete(id);
    let mine = this.hidden.get(owner);
    if (!mine) {
      mine = new Map();
      this.hidden.set(owner, mine);
    }
    mine.set(id, { link, at: new Date(at) });
    this.copies?.removeForDelete(owner, id, at);
    return true;
  }

  async unmarkDeleted(owner: OwnerId, id: string, since: Date): Promise<boolean> {
    const entry = this.hidden.get(owner)?.get(id);
    if (!entry || entry.at.getTime() < since.getTime()) return false;
    this.hidden.get(owner)?.delete(id);
    this.owned(owner).set(id, entry.link);
    this.copies?.restoreForUndo(owner, id, entry.at);
    return true;
  }

  async purgeDeleted(before: Date): Promise<number> {
    let purged = 0;
    for (const [owner, mine] of this.hidden) {
      for (const [id, entry] of mine) {
        if (entry.at.getTime() >= before.getTime()) continue;
        if (this.copies?.holdsFiles(owner, id)) continue;
        this.cascade(owner, id);
        purged++;
      }
    }
    return purged;
  }

  private isHidden(owner: OwnerId, id: string): boolean {
    return this.hidden.get(owner)?.has(id) === true;
  }

  async getSnapshotText(owner: OwnerId, linkId: string) {
    if (this.isHidden(owner, linkId)) return null;
    return this.snapshots.get(owner)?.get(linkId)?.text ?? null;
  }

  /** Maintenance read across owners: each link with its snapshot's status and text. */
  allLinkSnapshots(): {
    owner: OwnerId;
    linkId: string;
    url: string;
    snapshotStatus: SnapshotStatus | null;
    snapshotText: string | null;
  }[] {
    return [...this.links].flatMap(([owner, mine]) =>
      [...mine.values()].map((l) => {
        const s = this.snapshots.get(owner)?.get(l.id);
        return {
          owner,
          linkId: l.id,
          url: l.url,
          snapshotStatus: s?.status ?? null,
          snapshotText: s?.text ?? null,
        };
      }),
    );
  }

  async getTool(owner: OwnerId, linkId: string) {
    const tool = this.toolRows.get(owner)?.get(linkId);
    return tool ? structuredClone(tool) : null;
  }

  async listTools(owner: OwnerId) {
    const mine = this.toolRows.get(owner) ?? new Map<string, ToolRecord>();
    return new Map<string, ToolRecord>([...mine].map(([id, t]) => [id, structuredClone(t)]));
  }

  async updateToolIf(
    owner: OwnerId,
    linkId: string,
    expected: ToolRecord | null,
    next: ToolRecord | null,
    events?: EventWrite[],
  ): Promise<ToolWrite | null> {
    const link = this.owned(owner).get(linkId);
    if (!link) return null;
    let mine = this.toolRows.get(owner);
    if (!mine) {
      mine = new Map();
      this.toolRows.set(owner, mine);
    }
    const current = mine.get(linkId) ?? null;
    if (!sameTool(current, expected)) {
      return { tool: current && structuredClone(current), applied: false };
    }
    this.writeEvents(owner, linkId, this.settleEvents(link, events));
    if (next === null) {
      mine.delete(linkId);
      return { tool: null, applied: true };
    }
    mine.set(linkId, structuredClone(next));
    return { tool: structuredClone(next), applied: true };
  }

  async get(owner: OwnerId, id: string) {
    const found = this.owned(owner).get(id);
    return found ? this.view(owner, found) : null;
  }

  async update(owner: OwnerId, id: string, patch: LinkPatch, events?: EventWrite[]) {
    const found = this.owned(owner).get(id);
    if (!found) return null;
    const settled = this.settleEvents(found, events);
    this.checkEventKinds(settled);
    const { summaryOver, ...fields } = structuredClone(patch);
    if (summaryOver && !summaryOver.includes(found.summarySource)) {
      delete fields.summary;
      delete fields.summarySource;
    } else if (fields.summary !== undefined && fields.summarySource === undefined) {
      fields.summarySource = null;
    }
    if (fields.lastOpenedAt && found.lastOpenedAt && fields.lastOpenedAt < found.lastOpenedAt) {
      delete fields.lastOpenedAt;
    }
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) (found as Record<string, unknown>)[k] = v;
    }
    if (fields.tags) this.ensureTags(owner, fields.tags);
    this.writeEvents(owner, id, settled);
    return this.view(owner, found);
  }

  /** Drops the `record`s whose `unlessBefore` the link already matches; call it before the write. */
  private settleEvents(link: Link, events: EventWrite[] = []): EventWrite[] {
    return events.filter(
      (e) => !("record" in e) || !e.unlessBefore || !matchesExpectation(link, e.unlessBefore),
    );
  }

  /** A kind outside the log's five fails before anything is written, as SQLite's CHECK does. */
  private checkEventKinds(events: EventWrite[]): void {
    for (const e of events) {
      const kind = "record" in e ? e.record : e.unrecord;
      if (!LINK_EVENT_KINDS.includes(kind)) throw new Error(`Unknown event kind "${kind}".`);
    }
  }

  private writeEvents(owner: OwnerId, linkId: string, events: EventWrite[]): void {
    this.checkEventKinds(events);
    for (const e of events) {
      if ("record" in e) {
        this.events.push({ owner, linkId, kind: e.record, at: new Date(e.at), backfilled: false });
        continue;
      }
      const i = this.events.findIndex(
        (x) =>
          x.owner === owner &&
          x.linkId === linkId &&
          x.kind === e.unrecord &&
          x.at.getTime() === e.at.getTime(),
      );
      if (i >= 0) this.events.splice(i, 1);
    }
  }

  async updateWithReceipt(
    owner: OwnerId,
    id: string,
    patch: LinkPatch,
    _at: Date,
    extend?: string,
    events?: EventWrite[],
  ) {
    const found = this.owned(owner).get(id);
    if (!found) return null;
    const before = coveredOf(this.view(owner, found));
    const link = (await this.update(owner, id, patch, events)) as Link;
    const after = coveredOf(link);
    const changed = changedFields(before, after);
    if (!anyChanged(changed)) return { link, editId: null };
    return { link, editId: this.recordReceipt(owner, id, changed, before, after, extend) };
  }

  /** Replaces the link's record; with a live `extend` it also keeps that record's changes (see `extendedPrior`). */
  private recordReceipt(
    owner: OwnerId,
    id: string,
    changed: Changed,
    before: Covered,
    after: Covered,
    extend?: string,
  ): string {
    const key = imageKey(owner, id);
    const old = this.editRecords.get(key);
    const merged =
      old && old.editId === extend && holdsWritten(old.changed, old.written, before)
        ? extendedPrior(old, changed, before)
        : undefined;
    const editId = randomUUID();
    this.editRecords.set(key, {
      editId,
      changed: merged?.changed ?? changed,
      prior: merged?.prior ?? before,
      written: after,
      pictureChanged: merged && old ? old.pictureChanged : false,
      priorPicture: merged && old ? old.priorPicture : null,
      writtenSha: merged && old ? old.writtenSha : null,
    });
    return editId;
  }

  async fillWhyWithReceipt(owner: OwnerId, id: string, why: Labelled, _at: Date, extend?: string) {
    const found = this.owned(owner).get(id);
    if (!found) return null;
    const before = coveredOf(this.view(owner, found));
    const filled = found.why === null;
    const link = (await this.fillWhyIfMissing(owner, id, why)) as Link;
    if (!filled) return { link, editId: null };
    const after = coveredOf(link);
    const changed = changedFields(before, after);
    return { link, editId: this.recordReceipt(owner, id, changed, before, after, extend) };
  }

  async fillWhyIfMissing(owner: OwnerId, id: string, why: Labelled) {
    const found = this.owned(owner).get(id);
    if (!found) return null;
    if (found.why === null) found.why = { ...why };
    return this.view(owner, found);
  }

  async listTags(owner: OwnerId) {
    return this.catalog(owner).sort((a, b) =>
      Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)),
    );
  }

  async updateTag(owner: OwnerId, key: string, patch: TagPatch, expectedKind: TagKind) {
    const entry = this.catalogOf(owner).get(key);
    if (!entry || entry.kind !== expectedKind) return null;
    if (patch.kind !== undefined) entry.kind = patch.kind;
    if (patch.kindSource !== undefined) entry.kindSource = patch.kindSource;
    if (patch.projectStatus !== undefined) entry.projectStatus = patch.projectStatus;
    return structuredClone(entry);
  }

  async updateIf(
    owner: OwnerId,
    id: string,
    expected: LinkExpectation,
    patch: LinkPatch,
    events?: EventWrite[],
  ) {
    const found = this.owned(owner).get(id);
    if (!found) return null;
    if (!matchesExpectation(found, expected)) {
      return { link: this.view(owner, found), applied: false };
    }
    return { link: (await this.update(owner, id, patch, events)) as Link, applied: true };
  }

  async pinTag(
    owner: OwnerId,
    key: string,
    pin: { pinned: true; color: string } | { pinned: false },
  ) {
    const entry = this.catalogOf(owner).get(key);
    if (!entry) return null;
    entry.pinned = pin.pinned;
    if (pin.pinned) entry.color ??= pin.color;
    return structuredClone(entry);
  }

  async colorTag(owner: OwnerId, key: string, color: string) {
    const entry = this.catalogOf(owner).get(key);
    if (!entry) return null;
    entry.color = color;
    return structuredClone(entry);
  }

  async tagLinkCounts(owner: OwnerId) {
    const counts = new Map<string, number>();
    for (const link of this.owned(owner).values()) {
      for (const t of link.tags) counts.set(t.key, (counts.get(t.key) ?? 0) + 1);
    }
    return counts;
  }

  async sharedPairs(owner: OwnerId): Promise<[string, string][]> {
    const seen = new Set<string>();
    for (const link of this.owned(owner).values()) {
      const keys = link.tags.map((t) => t.key);
      for (const a of keys) for (const b of keys) if (a < b) seen.add(pairKey(a, b));
    }
    return [...seen].map(pairOf);
  }

  async dismissedPairs(owner: OwnerId): Promise<[string, string][]> {
    return [...(this.dismissals.get(owner) ?? [])].map(pairOf);
  }

  async dismissPair(owner: OwnerId, a: string, b: string, _at: Date): Promise<void> {
    const set = this.dismissals.get(owner) ?? new Set<string>();
    this.dismissals.set(owner, set.add(pairKey(a, b)));
  }

  async undismissPair(owner: OwnerId, a: string, b: string): Promise<void> {
    this.dismissals.get(owner)?.delete(pairKey(a, b));
  }

  async renameTag(owner: OwnerId, key: string, name: string, newKey: string) {
    const catalog = this.catalogOf(owner);
    const entry = catalog.get(key);
    if (!entry) return null;
    if (newKey !== key && catalog.has(newKey)) return "taken";
    entry.name = name;
    for (const link of this.everyLink(owner)) {
      for (const t of link.tags) if (t.key === key) Object.assign(t, { key: newKey, name });
    }
    if (newKey !== key) {
      catalog.delete(key);
      entry.key = newKey;
      catalog.set(newKey, entry);
      this.repointAliases(owner, key, newKey);
      this.aliasesOf(owner).set(key, newKey);
      this.cancelLinkEdits(owner, key);
    }
    return structuredClone(entry);
  }

  async mergeTag(
    owner: OwnerId,
    m: { from: Tag; into: Tag; set: TagSettings; at: Date; pruneBefore: Date },
  ) {
    if (m.from.key === m.into.key) throw new Error("A tag cannot be merged into itself.");
    this.pruneTagChanges(owner, m.pruneBefore);
    const catalog = this.catalogOf(owner);
    const from = catalog.get(m.from.key);
    const into = catalog.get(m.into.key);
    if (!from || !into) return null;
    if (!sameTag(from, m.from) || !sameTag(into, m.into)) return "conflict";
    const moved = this.liveWith(owner, from.key);
    const changed = this.everyLink(owner).filter((l) => l.tags.some((t) => t.key === from.key));
    const before = changed.map((l) => marksOf(l));
    const aliases = this.reachingAliases(owner, from.key);
    const keptBefore = settingsOf(into);
    for (const link of changed) {
      const old = link.tags.findIndex((t) => t.key === from.key);
      const kept = link.tags.find((t) => t.key === into.key);
      const oldTag = link.tags[old];
      if (!oldTag) continue;
      if (kept) {
        kept.source = strongerSource(kept.source, oldTag.source);
        link.tags.splice(old, 1);
      } else Object.assign(oldTag, { key: into.key, name: into.name });
    }
    this.repointAliases(owner, from.key, into.key);
    this.aliasesOf(owner).set(from.key, into.key);
    this.cancelLinkEdits(owner, from.key);
    catalog.delete(from.key);
    Object.assign(into, settingsOf(m.set));
    const changeId = this.recordTagChange(owner, {
      at: new Date(m.at),
      removed: structuredClone(from),
      aliases,
      kept: {
        key: into.key,
        before: keptBefore,
        after: settingsOf(into),
        links: this.everyLink(owner)
          .filter((l) => l.tags.some((t) => t.key === into.key))
          .map((l) => l.id),
      },
      links: changed.map((l, i) => ({ id: l.id, before: before[i] ?? [], after: marksOf(l) })),
    });
    return { tag: structuredClone(into), changeId, moved, links: this.liveWith(owner, into.key) };
  }

  async deleteTag(owner: OwnerId, d: { tag: Tag; at: Date; pruneBefore: Date }) {
    this.pruneTagChanges(owner, d.pruneBefore);
    const catalog = this.catalogOf(owner);
    const entry = catalog.get(d.tag.key);
    if (!entry) return null;
    if (!sameTag(entry, d.tag)) return "conflict";
    const moved = this.liveWith(owner, entry.key);
    const changed = this.everyLink(owner).filter((l) => l.tags.some((t) => t.key === entry.key));
    const before = changed.map((l) => marksOf(l));
    const aliases = this.reachingAliases(owner, entry.key);
    for (const link of changed) link.tags = link.tags.filter((t) => t.key !== entry.key);
    const mine = this.aliasesOf(owner);
    for (const [old, to] of mine) if (to === entry.key) mine.delete(old);
    this.cancelLinkEdits(owner, entry.key);
    catalog.delete(entry.key);
    const changeId = this.recordTagChange(owner, {
      at: new Date(d.at),
      removed: structuredClone(entry),
      aliases,
      address: this.aliasesOf(owner).get(entry.key) ?? null,
      links: changed.map((l, i) => ({ id: l.id, before: before[i] ?? [], after: marksOf(l) })),
    });
    return { changeId, moved };
  }

  async undoTagChange(owner: OwnerId, changeId: string, since: Date) {
    const r = this.tagChanges.get(owner)?.get(changeId);
    if (!r || r.at.getTime() < since.getTime()) return null;
    if (!this.unchangedSince(owner, r)) return "conflict";
    const waiting = [...(this.tagChanges.get(owner) ?? [])].map(([id, c]) => ({ id, ...c }));
    const newer = waiting.slice(waiting.findIndex((c) => c.id === changeId) + 1);
    const live = (c: TagChange) => c.at.getTime() >= since.getTime();
    if (newer.some((c) => live(c) && receiptsMeet(r, c) && this.unchangedSince(owner, c)))
      return "blocked";
    const catalog = this.catalogOf(owner);
    const mine = this.aliasesOf(owner);
    const kept = r.kept && catalog.get(r.kept.key);
    const links = r.links.flatMap((l) => {
      const link = this.linkOf(owner, l.id);
      return link ? [{ link, ...l }] : [];
    });
    const restored = structuredClone(r.removed);
    catalog.set(restored.key, restored);
    for (const key of r.aliases) mine.set(key, restored.key);
    if (r.kept && kept) {
      mine.delete(restored.key);
      Object.assign(kept, settingsOf(r.kept.before));
    }
    for (const { link, before } of links) {
      link.tags = before.map(({ key, source }) => {
        const t = catalog.get(key);
        if (!t) throw new Error(`Undo found no tag ${key} to put back.`);
        return { key, name: t.name, source, kind: t.kind, kindSource: t.kindSource };
      });
    }
    this.tagChanges.get(owner)?.delete(changeId);
    return {
      tags: [restored, ...(kept ? [kept] : [])].map((t) => ({
        tag: structuredClone(t),
        links: this.liveWith(owner, t.key),
      })),
    };
  }

  async currentKey(owner: OwnerId, key: string) {
    if (this.catalogOf(owner).has(key)) return key;
    return this.aliases.get(owner)?.get(key) ?? null;
  }

  /** Whether everything the receipt's Undo would put back is still as the change left it. */
  private unchangedSince(owner: OwnerId, r: TagChange): boolean {
    const catalog = this.catalogOf(owner);
    const mine = this.aliasesOf(owner);
    if (catalog.has(r.removed.key)) return false;
    if (!r.kept && (mine.get(r.removed.key) ?? null) !== (r.address ?? null)) return false;
    const kept = r.kept && catalog.get(r.kept.key);
    if (r.kept) {
      if (!kept || !sameSettings(kept, r.kept.after)) return false;
      const recorded = r.kept.links.filter((id) => this.linkOf(owner, id) !== undefined);
      const keptKey = kept.key;
      const now = this.everyLink(owner)
        .filter((l) => l.tags.some((t) => t.key === keptKey))
        .map((l) => l.id);
      if (recorded.length !== now.length || recorded.some((id) => !now.includes(id))) return false;
      if (mine.get(r.removed.key) !== kept.key) return false;
    }
    const changed = r.links.some((l) => {
      const link = this.linkOf(owner, l.id);
      return link !== undefined && !sameTags(marksOf(link), l.after);
    });
    if (changed) return false;
    return r.aliases.every(
      (key) => !catalog.has(key) && mine.get(key) === (kept ? kept.key : undefined),
    );
  }

  private linkOf(owner: OwnerId, id: string): Link | undefined {
    return this.owned(owner).get(id) ?? this.hidden.get(owner)?.get(id)?.link;
  }

  /** The owner's links, hidden included: a tag change rewrites both. */
  private everyLink(owner: OwnerId): Link[] {
    return [
      ...this.owned(owner).values(),
      ...[...(this.hidden.get(owner)?.values() ?? [])].map((e) => e.link),
    ];
  }

  private liveWith(owner: OwnerId, key: string): number {
    return [...this.owned(owner).values()].filter((l) => l.tags.some((t) => t.key === key)).length;
  }

  private aliasesOf(owner: OwnerId): Map<string, string> {
    let m = this.aliases.get(owner);
    if (!m) {
      m = new Map();
      this.aliases.set(owner, m);
    }
    return m;
  }

  private repointAliases(owner: OwnerId, from: string, to: string): void {
    const mine = this.aliasesOf(owner);
    for (const [old, key] of mine) if (key === from) mine.set(old, to);
  }

  /** The old keys that reach the tag: its aliases that no live tag shadows. */
  private reachingAliases(owner: OwnerId, key: string): string[] {
    const catalog = this.catalogOf(owner);
    return [...this.aliasesOf(owner)]
      .filter(([old, to]) => to === key && !catalog.has(old))
      .map(([old]) => old)
      .sort();
  }

  /** Removes the owner's link-edit records whose tags, before or after, name `key`. */
  private cancelLinkEdits(owner: OwnerId, key: string): void {
    for (const [k, record] of this.editRecords) {
      const [recordOwner] = JSON.parse(k) as [OwnerId, string];
      const names = [...record.prior.tags, ...record.written.tags].some((t) => t.key === key);
      if (recordOwner === owner && record.changed.tags && names) this.editRecords.delete(k);
    }
  }

  private pruneTagChanges(owner: OwnerId, before: Date): void {
    const mine = this.tagChanges.get(owner);
    for (const [id, r] of mine ?? []) if (r.at.getTime() < before.getTime()) mine?.delete(id);
  }

  private recordTagChange(owner: OwnerId, change: TagChange): string {
    let mine = this.tagChanges.get(owner);
    if (!mine) {
      mine = new Map();
      this.tagChanges.set(owner, mine);
    }
    const changeId = randomUUID();
    mine.set(changeId, change);
    return changeId;
  }

  async listLinks(owner: OwnerId) {
    return [...this.owned(owner).values()].map((l) => this.view(owner, l));
  }

  /** Both reads start before either is awaited, so no other call runs between them. */
  async listLinksAndTags(owner: OwnerId) {
    const links = this.listLinks(owner);
    const tags = this.listTags(owner);
    return { links: await links, tags: await tags };
  }

  async dueChecks(cutoffs: CheckCutoffs, limit: number): Promise<DueCheck[]> {
    const order = (id: string) => Number(id.replace(/^link-/, ""));
    const due: (DueCheck & { last: number })[] = [];
    for (const [owner, mine] of this.links) {
      for (const link of mine.values()) {
        const last = (this.checkRows.get(owner)?.get(link.id)?.checkedAt ?? link.savedAt).getTime();
        const cutoff = link.state === "active" ? cutoffs.active : cutoffs.archived;
        if (last <= cutoff.getTime()) due.push({ owner, linkId: link.id, url: link.url, last });
      }
    }
    due.sort((a, b) => a.last - b.last || order(a.linkId) - order(b.linkId));
    return due.slice(0, limit).map(({ owner, linkId, url }) => ({ owner, linkId, url }));
  }

  async getCheck(owner: OwnerId, linkId: string) {
    const check = this.checkRows.get(owner)?.get(linkId);
    return check ? structuredClone(check) : null;
  }

  async listChecks(owner: OwnerId) {
    const mine = this.checkRows.get(owner) ?? new Map<string, LinkCheck>();
    return new Map<string, LinkCheck>([...mine].map(([id, c]) => [id, structuredClone(c)]));
  }

  async updateCheckIf(
    owner: OwnerId,
    linkId: string,
    expected: LinkCheck | null,
    next: LinkCheck,
  ): Promise<CheckWrite | null> {
    if (!this.owned(owner).has(linkId)) return null;
    let mine = this.checkRows.get(owner);
    if (!mine) {
      mine = new Map();
      this.checkRows.set(owner, mine);
    }
    const current = mine.get(linkId) ?? null;
    if (!sameCheck(current, expected)) {
      return { check: current && structuredClone(current), applied: false };
    }
    // What the table refuses (its CHECK, and `toMs` on an invalid date), refused before any write.
    if (next.flaggedAt !== null && next.firstDeadAt === null) {
      throw new Error("A check cannot be flagged without a first dead check.");
    }
    for (const d of [next.checkedAt, next.firstDeadAt, next.flaggedAt, next.stillWorksAt]) {
      if (d !== null && !Number.isFinite(d.getTime())) {
        throw new RangeError("Cannot store an invalid date.");
      }
    }
    mine.set(linkId, structuredClone(next));
    return { check: structuredClone(next), applied: true };
  }

  async claimSurfaced(
    owner: OwnerId,
    ids: string[],
    {
      at,
      notSurfacedAfter,
      now,
      exceptKeptTools,
      exceptGone,
      expectedPutAwayAt,
    }: {
      at: Date;
      notSurfacedAfter: Date;
      now: Date;
      exceptKeptTools?: boolean;
      exceptGone?: boolean;
      expectedPutAwayAt?: Date;
    },
  ): Promise<SurfacedClaim[]> {
    const claimed: SurfacedClaim[] = [];
    for (const id of new Set(ids)) {
      const found = this.owned(owner).get(id);
      const stateFits =
        expectedPutAwayAt === undefined
          ? found?.state === "active"
          : found?.state === "archived" &&
            found.putAwayAt?.getTime() === expectedPutAwayAt.getTime();
      // A came-back claim is blocked only by a surfacing since the marker, and only inside the cooldown.
      const surfacedSince =
        expectedPutAwayAt === undefined ||
        (found?.lastSurfacedAt != null && found.lastSurfacedAt >= expectedPutAwayAt);
      if (
        !found ||
        !stateFits ||
        (found.snoozedUntil !== null && found.snoozedUntil > now) ||
        (exceptKeptTools === true && this.toolRows.get(owner)?.get(id)?.status === "kept") ||
        (exceptGone === true && (this.checkRows.get(owner)?.get(id)?.flaggedAt ?? null) !== null) ||
        (surfacedSince && found.lastSurfacedAt !== null && found.lastSurfacedAt > notSurfacedAfter)
      ) {
        continue;
      }
      const previousSurfacedAt = found.lastSurfacedAt;
      found.lastSurfacedAt = new Date(at);
      claimed.push({ link: this.view(owner, found), previousSurfacedAt });
    }
    return claimed;
  }

  async unclaimSurfaced(owner: OwnerId, id: string, claim: { at: Date; previous: Date | null }) {
    const found = this.owned(owner).get(id);
    if (found?.lastSurfacedAt?.getTime() !== claim.at.getTime()) return false;
    found.lastSurfacedAt = claim.previous && new Date(claim.previous);
    return true;
  }

  async pendingImages(afterId: string | null, limit: number): Promise<PendingImage[]> {
    const order = (id: string) => Number(id.replace(/^link-/, ""));
    const pending: PendingImage[] = [];
    for (const [owner, mine] of this.snapshots) {
      for (const [linkId, s] of mine) {
        const state = this.imageStates.get(imageKey(owner, linkId));
        const url = s.imageUrl ?? s.iconUrls[0] ?? null;
        if (url === null || state?.status !== "pending") continue;
        if (afterId !== null && order(linkId) <= order(afterId)) continue;
        pending.push({
          owner,
          linkId,
          imageUrl: url,
          role: s.imageUrl === null ? "icon" : "preview",
        });
      }
    }
    return pending.sort((a, b) => order(a.linkId) - order(b.linkId)).slice(0, limit);
  }

  async writeImage(
    owner: OwnerId,
    linkId: string,
    imageUrl: string,
    role: ImageRole,
    image: ImageBytes,
  ) {
    if (!this.settle(owner, linkId, imageUrl, role, "ok")) return false;
    const sha256 = createHash("sha256").update(image.bytes).digest("hex");
    this.storedImages.set(imageKey(owner, linkId), {
      contentType: image.contentType,
      bytes: new Uint8Array(image.bytes),
      version: imageVersion(sha256),
      role,
    });
    return true;
  }

  async endImage(owner: OwnerId, linkId: string, imageUrl: string, role: ImageRole, end: ImageEnd) {
    if (!this.settle(owner, linkId, imageUrl, role, end)) return false;
    const s = this.snapshots.get(owner)?.get(linkId);
    const next = role === "icon" ? s?.iconUrls[1] : undefined;
    if (s && next !== undefined) {
      s.iconUrls = [next];
      this.imageStates.set(imageKey(owner, linkId), { status: "pending" });
    }
    return true;
  }

  async imageVersions(owner: OwnerId, linkIds: string[]) {
    const versions = new Map<string, ShownPicture>();
    for (const id of linkIds) {
      if (this.isHidden(owner, id)) continue;
      const own = this.ownerImages.get(imageKey(owner, id));
      const page = this.storedImages.get(imageKey(owner, id));
      if (own) versions.set(id, { version: imageVersion(own.sha256), fit: "cover" });
      else if (page) versions.set(id, { version: page.version, fit: roleFit(page.role) });
    }
    return versions;
  }

  async image(
    owner: OwnerId,
    linkId: string,
    which?: "page" | "own",
  ): Promise<(StoredImage & { role?: ImageRole }) | null> {
    if (this.isHidden(owner, linkId)) return null;
    const key = imageKey(owner, linkId);
    const own = which === "page" ? undefined : this.ownerImages.get(key);
    if (own) return stored(own);
    if (which === "own") return null;
    const fetched = this.storedImages.get(key);
    return fetched
      ? {
          contentType: fetched.contentType,
          bytes: new Uint8Array(fetched.bytes),
          version: fetched.version,
          ...(which === "page" ? { role: fetched.role } : {}),
        }
      : null;
  }

  async pictureInfo(owner: OwnerId, linkIds: string[]) {
    const info = new Map<string, PictureInfo>();
    for (const id of linkIds) {
      if (this.isHidden(owner, id)) continue;
      const own = this.ownerImages.has(imageKey(owner, id));
      const page = this.storedImages.get(imageKey(owner, id));
      if (own || page)
        info.set(id, {
          own,
          pageVersion: page?.version ?? null,
          pageFit: page ? roleFit(page.role) : null,
        });
    }
    return info;
  }

  async applyEdit(owner: OwnerId, linkId: string, edit: LinkEdit, at: Date) {
    const link = this.owned(owner).get(linkId);
    if (!link) return null;
    const key = imageKey(owner, linkId);
    const own = this.ownerImages.get(key);
    const set = edit.picture !== undefined && edit.picture !== "page" ? edit.picture.set : null;
    const setSha = set ? sha256Hex(set.bytes) : null;
    const prior = coveredOf(this.view(owner, link));
    if (edit.tags && !sameTags(prior.tags, edit.tags.expected)) return "conflict";
    const titleChanged = edit.title !== undefined && edit.title !== link.title;
    const pictureChanged =
      edit.picture === "page" ? own !== undefined : setSha !== null && own?.sha256 !== setSha;
    const tags = edit.tags && !sameTags(prior.tags, edit.tags.set) ? edit.tags.set : null;
    if (!titleChanged && !pictureChanged && !tags) return { editId: null };
    const editId = randomUUID();
    if (tags) {
      link.tags = structuredClone(tags);
      this.ensureTags(owner, link.tags);
    }
    this.editRecords.set(key, {
      editId,
      changed: { title: titleChanged, summary: false, why: false, tags: tags !== null },
      prior,
      written: {
        ...prior,
        title: titleChanged ? (edit.title ?? null) : prior.title,
        tags: coveredOf(this.view(owner, link)).tags,
      },
      pictureChanged,
      priorPicture: pictureChanged && own ? structuredClone(own) : null,
      writtenSha: pictureChanged ? setSha : null,
    });
    if (titleChanged) link.title = edit.title ?? null;
    if (pictureChanged) {
      if (set && setSha) {
        this.ownerImages.set(key, {
          contentType: set.contentType,
          bytes: new Uint8Array(set.bytes),
          sha256: setSha,
          setAt: new Date(at),
        });
      } else this.ownerImages.delete(key);
    }
    return { editId };
  }

  async undoEdit(owner: OwnerId, linkId: string, editId: string): Promise<UndoOutcome | null> {
    const link = this.owned(owner).get(linkId);
    if (!link) return null;
    const key = imageKey(owner, linkId);
    const row = this.editRecords.get(key);
    if (!row || row.editId !== editId) return "conflict";
    const ownSha = this.ownerImages.get(key)?.sha256 ?? null;
    if (
      !holdsWritten(row.changed, row.written, coveredOf(this.view(owner, link))) ||
      (row.pictureChanged && ownSha !== row.writtenSha)
    ) {
      return "conflict";
    }
    const { changed, prior } = row;
    if (changed.title) link.title = prior.title;
    if (changed.summary) {
      link.summary = prior.summary;
      link.summarySource = prior.summarySource;
    }
    if (changed.why) link.why = prior.why && { ...prior.why };
    if (changed.tags) {
      link.tags = prior.tags.map((t) => ({ ...t }));
      this.ensureTags(owner, link.tags);
    }
    if (row.pictureChanged) {
      if (row.priorPicture) this.ownerImages.set(key, row.priorPicture);
      else this.ownerImages.delete(key);
    }
    this.editRecords.delete(key);
    return "undone";
  }

  private settle(
    owner: OwnerId,
    linkId: string,
    imageUrl: string,
    role: ImageRole,
    status: ImageStatus,
  ): boolean {
    const key = imageKey(owner, linkId);
    const state = this.imageStates.get(key);
    const s = this.snapshots.get(owner)?.get(linkId);
    const url = s?.imageUrl ?? s?.iconUrls[0] ?? null;
    const pendingRole: ImageRole = s?.imageUrl == null ? "icon" : "preview";
    if (state?.status !== "pending" || url !== imageUrl || pendingRole !== role) return false;
    this.imageStates.set(key, { status });
    return true;
  }

  seedTag(owner: OwnerId, tag: Tag): void {
    this.catalogOf(owner).set(tag.key, structuredClone(tag));
  }

  catalog(owner: OwnerId): Tag[] {
    return [...this.catalogOf(owner).values()].map((t) => structuredClone(t));
  }

  /** Test inspection: the snapshot's image status, as SQLite's `image_status` would read. */
  imageStatusOf(owner: OwnerId, linkId: string): string | null {
    return this.imageStates.get(imageKey(owner, linkId))?.status ?? null;
  }

  async summaryCandidates(
    afterId: string | null,
    limit: number,
    sources: (SummarySource | null)[],
  ): Promise<SummaryCandidate[]> {
    const order = (id: string) => Number(id.replace(/^link-/, ""));
    const found: SummaryCandidate[] = [];
    for (const [owner, mine] of this.snapshots) {
      for (const [id, s] of mine) {
        const link = this.owned(owner).get(id);
        if (!link || this.isHidden(owner, id)) continue;
        if (s.status !== "ok" || !s.text) continue;
        if (!sources.includes(link.summarySource)) continue;
        if (afterId !== null && order(id) <= order(afterId)) continue;
        found.push({ owner, id });
      }
    }
    return found.sort((a, b) => order(a.id) - order(b.id)).slice(0, limit);
  }

  async iconCandidates(afterId: string | null, limit: number): Promise<IconCandidate[]> {
    const order = (id: string) => Number(id.replace(/^link-/, ""));
    const found: IconCandidate[] = [];
    for (const [owner, mine] of this.snapshots) {
      for (const [linkId, s] of mine) {
        if (this.isHidden(owner, linkId) || !this.iconOpen(owner, linkId, s)) continue;
        if (afterId !== null && order(linkId) <= order(afterId)) continue;
        found.push({ owner, linkId, url: (this.owned(owner).get(linkId) as Link).url });
      }
    }
    return found.sort((a, b) => order(a.linkId) - order(b.linkId)).slice(0, limit);
  }

  async recordIconCheck(owner: OwnerId, linkId: string, iconUrls: string[]): Promise<boolean> {
    const s = this.snapshots.get(owner)?.get(linkId);
    if (!s || !this.iconOpen(owner, linkId, s) || iconUrls.length > MAX_ICON_URLS) {
      return false;
    }
    s.iconUrls = [...iconUrls];
    this.imageStates.set(imageKey(owner, linkId), {
      status: iconUrls.length > 0 ? "pending" : "none",
    });
    return true;
  }

  async wordPictureCandidates(afterId: string | null, limit: number): Promise<PreviewLink[]> {
    const order = (id: string) => Number(id.replace(/^link-/, ""));
    const found: PreviewLink[] = [];
    for (const [owner, mine] of this.snapshots) {
      for (const [linkId, s] of mine) {
        if (this.isHidden(owner, linkId) || s.imageUrl === null) continue;
        if (afterId !== null && order(linkId) <= order(afterId)) continue;
        const url = (this.owned(owner).get(linkId) as Link).url;
        found.push({ owner, linkId, url, imageUrl: s.imageUrl });
      }
    }
    return found.sort((a, b) => order(a.linkId) - order(b.linkId)).slice(0, limit);
  }

  async recordWordPictureCheck(
    owner: OwnerId,
    linkId: string,
    imageUrl: string,
    iconUrls: string[],
  ): Promise<boolean> {
    const s = this.snapshots.get(owner)?.get(linkId);
    if (!s || this.isHidden(owner, linkId) || s.imageUrl !== imageUrl) return false;
    if (iconUrls.length > MAX_ICON_URLS) return false;
    const key = imageKey(owner, linkId);
    s.imageUrl = null;
    s.iconUrls = [...iconUrls];
    this.imageStates.set(key, { status: iconUrls.length > 0 ? "pending" : "none" });
    if (this.storedImages.get(key)?.role === "preview") this.storedImages.delete(key);
    return true;
  }

  /** Test seeding: the image status a snapshot recorded before PR B has (NULL). */
  forgetIconCheck(owner: OwnerId, linkId: string): void {
    this.imageStates.delete(imageKey(owner, linkId));
  }

  /** An icon check may be recorded: unchecked, no fetched picture, and the link not flagged gone. */
  private iconOpen(owner: OwnerId, linkId: string, s: SnapshotRecord): boolean {
    return (
      this.iconUnchecked(owner, linkId, s) &&
      !this.storedImages.has(imageKey(owner, linkId)) &&
      (this.checkRows.get(owner)?.get(linkId)?.flaggedAt ?? null) === null
    );
  }

  /** The snapshot is ok, names no preview, and was never looked at for an icon. */
  private iconUnchecked(owner: OwnerId, linkId: string, s: SnapshotRecord): boolean {
    return (
      s.status === "ok" && s.imageUrl === null && !this.imageStates.has(imageKey(owner, linkId))
    );
  }

  async statsEvents(owner: OwnerId): Promise<StatsEvent[]> {
    return this.events
      .filter((e) => e.owner === owner && this.owned(owner).has(e.linkId))
      .map(({ linkId, kind, at }) => ({ linkId, kind, at: new Date(at) }))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  async trackingSince(): Promise<Date> {
    return new Date(this.since);
  }

  /** The stored reading, only while the owner has a live link saved at or before it. */
  private visibleReading(owner: OwnerId): StatsReading | undefined {
    const r = this.readings.get(owner);
    if (!r) return undefined;
    for (const l of this.owned(owner).values()) {
      if (l.savedAt.getTime() <= r.writtenAt.getTime()) return r;
    }
    return undefined;
  }

  async getReading(owner: OwnerId): Promise<StatsReading | null> {
    const r = this.visibleReading(owner);
    return r ? { ...r, writtenAt: new Date(r.writtenAt) } : null;
  }

  async putReadingIf(
    owner: OwnerId,
    expectedWrittenAt: Date | null,
    reading: StatsReading,
  ): Promise<boolean> {
    if (this.owned(owner).size === 0) return false;
    const held = this.readings.get(owner)?.writtenAt.getTime() ?? null;
    const replacesHidden =
      expectedWrittenAt === null && held !== null && !this.visibleReading(owner);
    if (held !== (expectedWrittenAt?.getTime() ?? null) && !replacesHidden) return false;
    this.readings.set(owner, { ...reading, writtenAt: new Date(reading.writtenAt) });
    return true;
  }

  async readingCandidates(dueBefore: Date): Promise<OwnerId[]> {
    return [...this.links]
      .filter(([owner, mine]) => {
        const r = this.readings.get(owner);
        return (
          mine.size > 0 &&
          (!r || r.writtenAt.getTime() <= dueBefore.getTime() || !this.visibleReading(owner))
        );
      })
      .map(([owner]) => owner)
      .sort();
  }

  /** Test inspection: the owner's log events for one link, in the order they were written. */
  eventsOf(owner: OwnerId, linkId: string): LoggedEvent[] {
    return this.events
      .filter((e) => e.owner === owner && e.linkId === linkId)
      .map(({ kind, at, backfilled }) => ({ kind, at: new Date(at), backfilled }));
  }

  /** Test inspection: all of an owner's links. */
  all(owner: OwnerId): Link[] {
    return [...this.owned(owner).values()].map((l) => this.view(owner, l));
  }
}
