import {
  isCimdClientIdUrlCandidate,
  validateCimdMetadata,
  validateClientIdUrl,
} from "@better-auth/cimd";
import { validatePublicClientJwks } from "@better-auth/oauth-provider/internal";
import { insideAuthLock } from "./auth-lock.js";
import { CIMD_METADATA_PROFILE } from "./client-admission.js";

/**
 * F: a snapshot counts as current for this long after its last successful fetch. Owner ruling,
 * 2026-10-13; it replaces condition 9's "the document's own caching headers".
 */
export const FRESHNESS_MS = 5 * 60_000;
/** How long better-auth's signed authorize query lives, and so how long a pending entry is pinned. */
export const PENDING_MS = 600_000;
/** New clients that may await the owner's approval at once. */
export const MAX_PENDING = 5;

/** The network side: PR A's guarded JSON fetcher, or a fake in tests. */
export type JsonFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<Response>;

type Resource = { url: string; body: string; etag: string | null; lastModified: string | null };
type Snapshot = { document: Resource; jwks: Resource | null; fetchedAt: number };

/** `gone`: withdrawn (404, 410) or invalid; the snapshot is dropped at once. */
export type RefreshResult = "ok" | "gone" | "failed";
export type PrefetchResult = RefreshResult | "full" | "refused";

const JSON_TYPE = /^application\/(?:[-\w.]+\+)?json\s*(?:;|$)/i;

type Got =
  | { kind: "modified"; resource: Resource }
  | { kind: "not-modified" }
  | { kind: "gone" }
  | { kind: "failed" };

const served = (body: string) =>
  new Response(body, {
    status: 200,
    // no-cache: cimd revalidates on every resolution, so the client row it keeps (and the
    // `jwks_uri` in it) always matches the current snapshot.
    headers: { "content-type": "application/json", "cache-control": "no-cache" },
  });

/**
 * Client metadata documents and their key sets, held in memory.
 * - Every network fetch happens here, outside the auth lock; one made inside it throws.
 * - `transport` is what cimd and better-auth's key-set code read through. It answers only from
 *   current snapshots, from memory, and never touches the network.
 * - A snapshot is one document plus the key set that document names, fetched together and
 *   published together, so a `jwks_uri` change lands with the document that makes it.
 */
export function createMetadataStash({
  fetch,
  now = Date.now,
  freshnessMs = FRESHNESS_MS,
}: {
  fetch: JsonFetch;
  now?: () => number;
  freshnessMs?: number;
}) {
  const snapshots = new Map<string, Snapshot>();
  /** Pending clients: the time each stays pinned until. */
  const pins = new Map<string, number>();
  let connected = new Set<string>();
  const inFlight = new Map<AbortController, Promise<unknown>>();
  let closed = false;

  const current = (s: Snapshot | undefined): s is Snapshot =>
    s !== undefined && now() - s.fetchedAt < freshnessMs;
  const pinned = (clientId: string) => (pins.get(clientId) ?? 0) > now();
  const wanted = (clientId: string) => connected.has(clientId) || pinned(clientId);

  async function get(url: string, previous: Resource | null): Promise<Got> {
    if (insideAuthLock()) throw new Error("a metadata fetch must never run inside the auth lock");
    if (closed) return { kind: "failed" };
    const headers: Record<string, string> = { accept: "application/json" };
    if (previous?.etag) headers["if-none-match"] = previous.etag;
    if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
    const controller = new AbortController();
    const run = (async (): Promise<Got> => {
      const res = await fetch(url, { headers, signal: controller.signal });
      if (res.status === 304 && previous) return { kind: "not-modified" };
      if (res.status === 404 || res.status === 410) return { kind: "gone" };
      if (res.status !== 200) return { kind: "failed" };
      if (!JSON_TYPE.test(res.headers.get("content-type") ?? "")) return { kind: "gone" };
      const body = await res.text();
      const etag = res.headers.get("etag");
      const lastModified = res.headers.get("last-modified");
      return { kind: "modified", resource: { url, body, etag, lastModified } };
    })().catch((): Got => ({ kind: "failed" }));
    inFlight.set(controller, run);
    try {
      return await run;
    } finally {
      inFlight.delete(controller);
    }
  }

  const validDocument = (clientId: string, body: string) => {
    try {
      const result = validateCimdMetadata(clientId, JSON.parse(body), {
        metadataProfile: CIMD_METADATA_PROFILE,
      });
      return result.valid ? result.metadata : null;
    } catch {
      return null;
    }
  };

  const validKeySet = (body: string) => {
    try {
      return validatePublicClientJwks(JSON.parse(body)).valid;
    } catch {
      return false;
    }
  };

  async function fetchSnapshot(
    clientId: string,
    previous: Snapshot | undefined,
  ): Promise<Snapshot | "gone" | "failed"> {
    const startedAt = now();
    const doc = await get(clientId, previous?.document ?? null);
    if (doc.kind === "gone" || doc.kind === "failed") return doc.kind;
    const document = doc.kind === "modified" ? doc.resource : (previous as Snapshot).document;
    const metadata = validDocument(clientId, document.body);
    if (!metadata) return "gone";
    let jwks: Resource | null = null;
    if (metadata.jwks_uri) {
      const before = previous?.jwks?.url === metadata.jwks_uri ? previous.jwks : null;
      const keys = await get(metadata.jwks_uri, before);
      if (keys.kind === "modified" && validKeySet(keys.resource.body)) jwks = keys.resource;
      else if (keys.kind === "not-modified") jwks = before;
      else return "failed";
    }
    return { document, jwks, fetchedAt: startedAt };
  }

  /**
   * Fetches a client's snapshot afresh. A withdrawn or invalid document drops it at once; any
   * other failure leaves it, so it stops being current F after its last success.
   */
  async function refresh(clientId: string): Promise<RefreshResult> {
    const result = await fetchSnapshot(clientId, snapshots.get(clientId));
    if (result === "gone") {
      snapshots.delete(clientId);
      return "gone";
    }
    if (result === "failed") return "failed";
    if (wanted(clientId)) snapshots.set(clientId, result);
    return "ok";
  }

  const pendingCount = () =>
    [...pins.keys()].filter((id) => pinned(id) && !connected.has(id)).length;

  return {
    /** Whether better-auth may resolve this client id: it has a current snapshot. */
    isCurrent: (clientId: string) => current(snapshots.get(clientId)),

    /** cimd's transport: answers from current snapshots only, and never fetches. */
    transport: async (input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      for (const [clientId, snapshot] of snapshots) {
        if (!current(snapshot)) continue;
        if (clientId === url) return served(snapshot.document.body);
        if (snapshot.jwks?.url === url) return served(snapshot.jwks.body);
      }
      throw new Error("this client's metadata is not available");
    },

    refresh,

    /**
     * For an owner's authorize naming a CIMD client that is not connected: fetches its snapshot
     * and pins it for the signed query's lifetime. Refused while MAX_PENDING others are pending.
     */
    async prefetch(clientId: string): Promise<PrefetchResult> {
      if (!isCimdClientIdUrlCandidate(clientId) || validateClientIdUrl(clientId) !== null) {
        return "refused";
      }
      if (!pinned(clientId)) {
        if (pendingCount() >= MAX_PENDING) return "full";
        pins.set(clientId, now() + PENDING_MS);
      }
      if (current(snapshots.get(clientId))) return "ok";
      const result = await refresh(clientId);
      if (result !== "ok") pins.delete(clientId);
      return result;
    },

    /** Extends a pending client's pin to a full signed-query lifetime from now. */
    pin(clientId: string) {
      if (pins.has(clientId)) pins.set(clientId, now() + PENDING_MS);
    },

    /**
     * Takes the connected set, forgets expired pins and every snapshot neither connected nor
     * pinned, and returns the client ids to keep refreshed.
     */
    sync(connectedNow: Set<string>): string[] {
      connected = connectedNow;
      for (const id of [...pins.keys()]) if (!pinned(id) || connected.has(id)) pins.delete(id);
      for (const id of [...snapshots.keys()]) if (!wanted(id)) snapshots.delete(id);
      return [...new Set([...connected, ...pins.keys()])];
    },

    /** Refuses new fetches, aborts those in flight, and waits for them to settle. */
    async close() {
      closed = true;
      for (const controller of inFlight.keys()) controller.abort();
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}

export type MetadataStash = ReturnType<typeof createMetadataStash>;
