import { createHash, randomBytes } from "node:crypto";
import type { OwnerId } from "../core/types.js";
import type { KeyInfo, SqliteKeyStore } from "../store/key-store.js";
import type { Identify } from "./caller.js";

export class AgentKeyError extends Error {
  constructor(
    readonly code: "invalid_agent" | "unknown_agent",
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

/** Returns the new key's plaintext, which is not stored and cannot be shown again. */
export function createAgentKey(
  keys: SqliteKeyStore,
  who: { owner: OwnerId; ownerName: string; agent: string },
  now: Date = new Date(),
): string {
  const agent = who.agent.trim();
  if (agent === "") {
    throw new AgentKeyError("invalid_agent", "Give the agent a name, such as codex.");
  }
  const key = generateKey();
  keys.create(who.owner, who.ownerName, agent, hashKey(key), now);
  return key;
}

export const listAgentKeys = (keys: SqliteKeyStore, owner: OwnerId): KeyInfo[] => keys.list(owner);

export function revokeAgentKey(
  keys: SqliteKeyStore,
  owner: OwnerId,
  agent: string,
  now: Date = new Date(),
): void {
  if (!keys.revoke(owner, agent.trim(), now)) {
    throw new AgentKeyError("unknown_agent", `Agent "${agent}" has no live key to revoke.`);
  }
}
