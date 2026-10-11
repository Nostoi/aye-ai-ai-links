import type { OwnerId } from "../core/types.js";

/** Who is calling: the owner whose data it is, and the agent name recorded as savedBy. */
export type Caller = { owner: OwnerId; savedBy: string };

/** Resolves a request to its caller, or null when it carries no valid credentials. */
export type Identify = (request: Request) => Promise<Caller | null>;
