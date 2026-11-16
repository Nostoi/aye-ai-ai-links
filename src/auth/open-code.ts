import { OPEN_CODE_SHAPE, type Opener } from "../core/open-codes.js";

/** Finds a code's opener from the code alone: the store's one read not scoped by an owner. */
export type OpenCodeLookup = { findByCode(code: string): Opener | null };

/**
 * Who an open code (#133) acts for: the owner, link and agent it was issued for, or null for
 * anything that is not a live code. The code is a bearer credential: it admits a request with no
 * session as that owner, for one action, recording that one link's opening. Every call after
 * this takes the owner it returns.
 */
export const openerOf = (codes: OpenCodeLookup, code: string): Opener | null =>
  OPEN_CODE_SHAPE.test(code) ? codes.findByCode(code) : null;
