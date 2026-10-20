import type { ToolChange } from "../core/tools.js";
import type { Source, TagKind } from "../core/types.js";

/** A profile note or focus entry a tool call wrote or removed, with its label. */
export type ProfileEntry = { entry: "note" | "focus"; id: string; text: string; source: Source };

/**
 * What one write committed, recorded as it commits, so a call that then fails still lists it.
 * It says which operation ran and what it wrote, not that a value differs. `fields` names the
 * link fields an `update_link` sent; it is [] for a new save, and ["why"] for a repeat save that
 * filled a missing why. `surfaced` holds every link a digest marked, shown or not.
 */
export type Change =
  | {
      kind: "link";
      tool: "save_link" | "update_link";
      linkId: string;
      created: boolean;
      fields: string[];
      /** The id for Undo, or null. */
      editId: string | null;
    }
  | { kind: "handy"; linkId: string; change: ToolChange }
  | { kind: "tag"; name: string; tagKind: TagKind }
  | { kind: "profile"; added: ProfileEntry[]; edited: ProfileEntry[]; removed: ProfileEntry[] }
  | { kind: "surfaced"; linkIds: string[] };

/** The in-app AI's recorder. The MCP door passes none, and its results never carry these. */
export type RecordChange = (change: Change) => void;
