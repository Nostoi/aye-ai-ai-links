import { createHash, randomBytes } from "node:crypto";
import type { OwnerId } from "../core/types.js";
import type { KeyInfo, SqliteKeyStore } from "../store/key-store.js";
import type { Identify } from "./caller.js";
import { WEB_SAVED_BY } from "./session.js";

export class AgentKeyError extends Error {
  constructor(
    readonly code: "invalid_agent" | "unknown_agent" | "unknown_key" | "undo_expired",
    message: string,
  ) {
    super(message);
    this.name = "AgentKeyError";
  }
}

/** `aak_` plus 32 random bytes, base64url. Shown once, at creation. */
export const generateKey = (): string => `aak_${randomBytes(32).toString("base64url")}`;

/** Keys are high-entropy, so a fast hash is enough; only this digest is stored. */
export const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/**
 * The token from `Authorization: Bearer <token>` (RFC 9110 §11.1, RFC 6750 §2.1): scheme matched
 * case-insensitively, one or more spaces, then exactly one token, taken as given.
 */
export function bearerToken(header: string | null): string | null {
  const [, scheme, token] = /^([A-Za-z]+) +(\S+)$/.exec(header ?? "") ?? [];
  return scheme?.toLowerCase() === "bearer" && token !== undefined ? token : null;
}

/** Agent keys start with this; any other bearer token is an OAuth access token. */
export const AGENT_KEY_PREFIX = "aak_";

/** The bearer token when it has an agent key's shape, else null. */
export function parseBearer(header: string | null): string | null {
  const token = bearerToken(header);
  return token !== null && /^aak_[A-Za-z0-9_-]+$/.test(token) ? token : null;
}

/**
 * Looks the key up afresh on every request, so a revocation applies to the next one. Agent keys
 * are rate limited per owner and agent, in a bucket no OAuth client can share.
 */
export const keyIdentify =
  (keys: SqliteKeyStore): Identify =>
  async (request) => {
    const token = parseBearer(request.headers.get("authorization"));
    const found = token === null ? null : keys.findLiveByHash(hashKey(token));
    return found
      ? { owner: found.owner, savedBy: found.name, rateKey: `key:${found.owner}/${found.name}` }
      : null;
  };

/** Counted in characters, not UTF-16 units, after trimming. */
export const MAX_AGENT_NAME = 60;

/** How long after a key is turned off it can be turned back on. */
export const UNDO_WINDOW_MS = 60_000;

/**
 * The agent's name, trimmed. It is refused when blank, longer than `MAX_AGENT_NAME`, or "web" in
 * any case, which is the `savedBy` of links saved on the web page.
 */
function agentName(raw: string): string {
  const agent = raw.trim();
  if (agent === "") {
    throw new AgentKeyError("invalid_agent", "Give the agent a name, such as codex.");
  }
  if ([...agent].length > MAX_AGENT_NAME) {
    throw new AgentKeyError(
      "invalid_agent",
      `Keep the name to ${MAX_AGENT_NAME} characters or fewer.`,
    );
  }
  if (/[\p{Cc}\p{Cs}]/u.test(agent)) {
    throw new AgentKeyError(
      "invalid_agent",
      "Use only printable characters: no tabs, line breaks or other control characters.",
    );
  }
  if (agent.toLowerCase() === WEB_SAVED_BY) {
    throw new AgentKeyError(
      "invalid_agent",
      `"${WEB_SAVED_BY}" names links saved on the web page. Choose another name.`,
    );
  }
  return agent;
}

/** The new key's plaintext is not stored and cannot be shown again. */
export function createAgentKey(
  keys: SqliteKeyStore,
  who: { owner: OwnerId; ownerName: string; agent: string },
  now: Date = new Date(),
): { id: number; name: string; key: string } {
  const name = agentName(who.agent);
  const key = generateKey();
  const id = keys.create(who.owner, who.ownerName, name, hashKey(key), now);
  return { id, name, key };
}

export const listAgentKeys = (keys: SqliteKeyStore, owner: OwnerId): KeyInfo[] => keys.list(owner);

export function revokeAgentKey(
  keys: SqliteKeyStore,
  owner: OwnerId,
  agent: string,
  now: Date = new Date(),
): void {
  if (!keys.revoke(owner, agent.trim(), now)) {
    throw new AgentKeyError("unknown_agent", `Agent "${agent}" has no live key to turn off.`);
  }
}

/** Turns off the owner's key `id`; the next request with it is refused. */
export function turnOffAgentKey(
  keys: SqliteKeyStore,
  owner: OwnerId,
  id: number,
  now: Date = new Date(),
): void {
  if (!keys.revokeById(owner, id, now)) {
    throw new AgentKeyError("unknown_key", "That key is already off. Reload the page.");
  }
}

/**
 * Turns the owner's key `id` back on, if it was turned off within `UNDO_WINDOW_MS`. A key whose
 * name has a new key since stays off (`KeyStoreError` `name_taken`).
 */
export function turnOnAgentKey(
  keys: SqliteKeyStore,
  owner: OwnerId,
  id: number,
  now: Date = new Date(),
): void {
  if (!keys.restore(owner, id, new Date(now.getTime() - UNDO_WINDOW_MS))) {
    throw new AgentKeyError("undo_expired", "It's too late to undo. That key stays off.");
  }
}
