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
import { sameTool, type ToolRecord, type ToolStore, type ToolWrite } from "./tool-store.js";
import type {
  Labelled,
  Link,
  LinkEventKind,
  LinkPatch,
  NewLink,
  OwnerId,
  SnapshotStatus,
  SummarySource,
  Tag,
  TagKind,
  TagPatch,
} from "./types.js";

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
    SummaryCandidates
{
  private snapshots = new Map<OwnerId, Map<string, SnapshotRecord>>();
  /** The lease token of each snapshot, by owner then link id; absent means 0. */
  private tokens = new Map<OwnerId, Map<string, number>>();
  private links = new Map<OwnerId, Map<string, Link>>();
  private hidden = new Map<OwnerId, Map<string, { link: Link; at: Date }>>();
  private tags = new Map<OwnerId, Map<string, Tag>>();
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

  async listLinks(owner: OwnerId) {
    return [...this.owned(owner).values()].map((l) => this.view(owner, l));
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
