import type { LinkStore } from "./store.js";
import type { Labelled, Link, LinkPatch, NewLink, OwnerId, Tag } from "./types.js";

/** In-memory LinkStore for tests; honours the same contracts as the real store. */
export class FakeStore implements LinkStore {
  private links = new Map<OwnerId, Map<string, Link>>();
  private tags = new Map<OwnerId, Map<string, Tag>>();
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
    for (const t of out.tags) {
      const entry = catalog.get(t.key);
      t.name = entry?.name ?? t.name;
      t.kind = entry?.kind ?? t.kind;
    }
    return out;
  }

  async insertIfAbsent(owner: OwnerId, link: NewLink) {
    const mine = this.owned(owner);
    for (const existing of mine.values()) {
      if (existing.urlKey === link.urlKey) {
        return { link: this.view(owner, existing), created: false };
      }
    }
    this.ensureTags(owner, link.tags);
    const stored: Link = { ...structuredClone(link), id: `link-${this.nextId++}` };
    mine.set(stored.id, stored);
    return { link: this.view(owner, stored), created: true };
  }

  async get(owner: OwnerId, id: string) {
    const found = this.owned(owner).get(id);
    return found ? this.view(owner, found) : null;
  }

  async update(owner: OwnerId, id: string, patch: LinkPatch) {
    const found = this.owned(owner).get(id);
    if (!found) return null;
    const fields = structuredClone(patch);
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) (found as Record<string, unknown>)[k] = v;
    }
    if (fields.tags) this.ensureTags(owner, fields.tags);
    return this.view(owner, found);
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

  seedTag(owner: OwnerId, tag: Tag): void {
    this.catalogOf(owner).set(tag.key, structuredClone(tag));
  }

  catalog(owner: OwnerId): Tag[] {
    return [...this.catalogOf(owner).values()].map((t) => structuredClone(t));
  }

  /** Test inspection: all of an owner's links. */
  all(owner: OwnerId): Link[] {
    return [...this.owned(owner).values()].map((l) => this.view(owner, l));
  }
}
