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
  | { kind: "tag-rename"; from: string; name: string }
  /** `links`: the links the tag was moved or removed from. `undoId` is the tool's own, for `undo_tag_change`. */
  | { kind: "tag-merge"; name: string; into: string; links: number; undoId: string }
  | { kind: "tag-delete"; name: string; links: number; undoId: string }
  /** An `undo_tag_change` that worked: `tags` are the names it put back. The panel marks the change with this `undoId` as undone. */
  | { kind: "tag-undo"; undoId: string; tags: string[] }
  | { kind: "profile"; added: ProfileEntry[]; edited: ProfileEntry[]; removed: ProfileEntry[] }
  | { kind: "surfaced"; linkIds: string[] };

/** The in-app AI's recorder. The MCP door passes none, and its results never carry these. */
export type RecordChange = (change: Change) => void;
