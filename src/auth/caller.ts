import type { OwnerId } from "../core/types.js";

/** Who is calling: the owner whose data it is, and the agent name recorded as savedBy. */
export type Caller = { owner: OwnerId; savedBy: string };

/** A caller and the rate-limit bucket its requests count against. */
export type Identity = Caller & { rateKey: string };

/** Resolves a request to its caller, or null when it carries no valid credentials. */
export type Identify = (request: Request) => Promise<Identity | null>;
