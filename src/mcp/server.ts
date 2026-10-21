import {
  McpServer,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Caller } from "../auth/caller.js";
import { getDigest } from "../core/digest.js";
import { CoreError } from "../core/errors.js";
import { filingContext } from "../core/filing-context.js";
import type { LinkCheckStore } from "../core/link-check-store.js";
import {
  getLink,
  getLinkWithText,
  normalizeTitle,
  saveLink,
  updateLink,
  updateLinkWithReceipt,
} from "../core/links.js";
import { listLinks } from "../core/list-links.js";
import {
  addProfile,
  editProfile,
  getProfile,
  profileContext,
  type WrittenEntry,
} from "../core/profile.js";
import type { ProfileStore } from "../core/profile-store.js";
import type { SavedCopyReader } from "../core/saved-copy.js";
import { LINK_ORDERS, type LinkCount, type LinkSearch } from "../core/search.js";
import { searchLinks } from "../core/search-links.js";
import type { SnapshotRunner } from "../core/snapshot-runner.js";
import type { PageTextReader } from "../core/snapshot-text.js";
import type { LinkStore } from "../core/store.js";
import { changeTagKind } from "../core/tag-kind.js";
import { normalizeTags } from "../core/tags.js";
import type { ToolStore } from "../core/tool-store.js";
import { SOURCES, STATES, TAG_KINDS } from "../core/types.js";
import { putAwayLink } from "../core/worth-a-look.js";
import type { ProfileEntry, RecordChange } from "./changes.js";
import * as guidance from "./guidance.js";
import {
  applyHandy,
  applyHandyToSaved,
  HANDY_ACTIONS,
  type HandyLink,
  linksWithHandy,
  linkWithHandy,
} from "./handy.js";
import {
  addProfileOutput,
  advertisedOpen,
  getDigestOutput,
  getLinkOutput,
  getProfileOutput,
  linkResultOutput,
  listLinksOutput,
  profileOutput,
  saveLinkOutput,
  searchLinksOutput,
  updateTagOutput,
} from "./output-schemas.js";

export type McpDeps = {
  store: LinkStore;
  tools: ToolStore;
  /** Dead-link checks: core leaves gone links out of the digest (#128). */
  checks: LinkCheckStore;
  search: LinkSearch;
  keywordSearch: LinkSearch;
  count: LinkCount;
  profile: ProfileStore;
  now: () => Date;
  snapshots?: Pick<SnapshotRunner, "kick"> | undefined;
  pages: PageTextReader;
  /** Whether a saved copy exists, for get_link; an agent never gets the copy itself. */
  savedCopies: Pick<SavedCopyReader, "copyInfo">;
  saveWaitMs?: number | undefined;
  /** What `serverInfo` reports; `dev` when left out. */
  version?: string | undefined;
};

/** Wraps each tool call's promise; `mcpApp` uses it to count calls still running. */
export type TrackCall = <T>(call: Promise<T>) => Promise<T>;

const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** The written year-month-day must be a real calendar day; Date.parse would roll 02-30 to 03-02. */
function isRealCalendarDay(s: string): boolean {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number) as [number, number, number];
  const day = new Date(0);
  day.setUTCFullYear(y, m - 1, d);
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
}

const timestamp = z
  .string()
  .refine((s) => TIMESTAMP_SHAPE.test(s) && isRealCalendarDay(s) && !Number.isNaN(Date.parse(s)), {
    message:
      "Not a valid timestamp. Send a full ISO-8601 timestamp with an offset or Z and at most 3 decimal places, such as 2026-10-01T09:30:00Z.",
  });

const source = z.enum(SOURCES);
const why = z.object({ text: z.string(), source });
const tags = z.array(
  z.object({
    name: z.string(),
    source,
    kind: z
      .enum(TAG_KINDS)
      .optional()
      .describe(
        'If sent, source also labels the kind: "stated" or "asked" only if the owner gave the kind.',
      ),
  }),
);

const handy = z
  .object({ action: z.enum(HANDY_ACTIONS), source })
  .describe(
    'Keep handy, for a tool the owner uses regularly. keep: "stated" or "asked" keeps it; "inferred" only suggests it. still_using answers a still_using_check and not_handy declines it; both take "stated" or "asked" only.',
  );

const saveLinkInput = z.object({
  url: z.string(),
  title: z.string().optional(),
  summary: z.string().optional(),
  why: why.optional(),
  tags: tags.optional(),
  handy: handy.optional(),
});
const updateLinkInput = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  why: why.nullable().optional(),
  tags: tags.optional(),
  handy: handy.optional(),
  state: z.enum(STATES).optional(),
  snoozedUntil: timestamp.nullable().optional(),
  opened: z.literal(true).optional(),
  putAway: z.literal(true).optional(),
});
const searchLinksInput = z.object({
  query: z.string(),
  tag: z.string().optional(),
  project: z.string().optional(),
  savedFrom: timestamp.optional(),
  savedTo: timestamp.optional(),
  limit: z.number().optional(),
});
const listLinksInput = z.object({
  order: z.enum(LINK_ORDERS).optional(),
  tag: z.string().optional(),
  project: z.string().optional(),
  state: z.enum(STATES).optional(),
  savedFrom: timestamp.optional(),
  savedTo: timestamp.optional(),
  cursor: z.string().optional(),
  limit: z.number().optional(),
});
const updateTagInput = z.object({ name: z.string(), kind: z.enum(TAG_KINDS) });
const getLinkInput = z.object({ id: z.string() });
// A strict empty object advertises additionalProperties: false, the schema MCP recommends for a tool with no parameters.
const getProfileInput = z.strictObject({});
const getDigestInput = z.strictObject({});
const labelledText = z.object({ text: z.string(), source });
const addProfileInput = z.object({
  addNotes: z.array(labelledText).optional(),
  addFocus: z.array(labelledText).optional(),
});
const editProfileInput = z.object({
  editNotes: z.array(z.object({ id: z.string(), text: z.string(), source })).optional(),
  removeNotes: z.array(z.string()).optional(),
});

const toDate = (s: string | undefined) => (s === undefined ? undefined : new Date(s));

const entries = (entry: ProfileEntry["entry"], list: WrittenEntry[]): ProfileEntry[] =>
  list.map(({ id, text, source }) => ({ entry, id, text, source }));

function ok(payload: unknown) {
  // A JSON round trip turns Dates into ISO strings, for both content and structuredContent.
  const data = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** Core errors are written for agents; anything else must not leak internals. */
function toFailure(error: unknown) {
  if (error instanceof CoreError) return fail(error.message);
  if (error instanceof Error && (error as { code?: unknown }).code === "unknown_owner") {
    return fail(
      "The owner record for this key is missing. This is a server setup problem, not something to retry: tell the owner to create an agent key or run setup.",
    );
  }
  console.error("[mcp] unexpected tool error:", error);
  return fail(
    "Something went wrong on the server. Try again; if it keeps failing, tell the owner.",
  );
}

const OUTPUT_MISMATCH =
  "The request was handled and any change you asked for was saved, but the result could not be returned in its declared shape. Do not retry it. Tell the owner.";

/**
 * The SDK checks a result only after the handler has committed, and reports a mismatch
 * without logging it, so check here first: the agent then learns the change was saved.
 */
async function guarded(output: z.ZodType, run: () => Promise<unknown>) {
  try {
    const result = ok(await run());
    const check = output.safeParse(result.structuredContent);
    if (check.success) return result;
    console.error("[mcp] result does not match its output schema:", check.error.issues);
    return fail(OUTPUT_MISMATCH);
  } catch (error) {
    return toFailure(error);
  }
}

type ToolConfig<I extends StandardSchemaWithJSON> = {
  description: string;
  inputSchema: I;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
};

/**
 * The caller comes from the authenticated request, never from tool arguments. `record` hears
 * each write as it commits (the in-app AI's change list); it never changes a tool's result. Only
 * with a recorder do the writes keep Undo receipts, and their ids go to `record` alone.
 */
export function buildMcpServer(
  deps: McpDeps,
  caller: Caller,
  track: TrackCall = (call) => call,
  recorder?: RecordChange,
): McpServer {
  const server = new McpServer(
    { name: "aye-ai-ai-links", version: deps.version ?? "dev" },
    { instructions: guidance.INSTRUCTIONS },
  );
  const { owner, savedBy } = caller;
  const receipts = recorder !== undefined;
  const record: RecordChange = recorder ?? (() => {});
  const lastEdit = new Map<string, string>();
  const remember = (linkId: string, editId: string | null) => {
    if (editId) lastEdit.set(linkId, editId);
  };

  /** Each tool states its output schema once: `tools/list` shows it open, `guarded` checks it strictly. */
  const register = <I extends StandardSchemaWithJSON>(
    name: string,
    { outputSchema, ...config }: ToolConfig<I>,
    run: (args: StandardSchemaWithJSON.InferOutput<I>) => Promise<unknown>,
  ) =>
    server.registerTool(
      name,
      { ...config, outputSchema: advertisedOpen(outputSchema) },
      // ToolCallback<I> is a conditional type TypeScript cannot resolve while I is generic.
      ((args: StandardSchemaWithJSON.InferOutput<I>) =>
        track(guarded(outputSchema, () => run(args)))) as ToolCallback<I>,
    );

  register(
    "save_link",
    {
      description: guidance.SAVE_LINK,
      inputSchema: saveLinkInput,
      outputSchema: saveLinkOutput,
      // Every hint is set: the spec defaults are destructive and open-world (https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        // Saving fetches the new link's page in the background.
        openWorldHint: true,
      },
    },
    async ({ handy, ...args }) => {
      // One instant for the save and its keep, as getDigest and markOpened do.
      const now = deps.now();
      const at = { ...deps, now: () => now };
      const input = { ...args, savedBy };
      const { whyFilled, whyEditId, ...saved } = receipts
        ? await saveLink(at, owner, input, { receipt: true, extend: (id) => lastEdit.get(id) })
        : { ...(await saveLink(at, owner, input)), whyEditId: null };
      const linkId = saved.link.id;
      remember(linkId, whyEditId);
      if (saved.created || whyFilled) {
        const fields = saved.created ? [] : ["why"];
        record({
          kind: "link",
          tool: "save_link",
          linkId,
          created: saved.created,
          fields,
          editId: whyEditId,
        });
      }
      // A repeat save keeps its contract (only a missing why is filled), so handy is ignored.
      if (handy && saved.created) {
        const change = await applyHandyToSaved(at, owner, linkId, handy);
        record({ kind: "handy", linkId, change });
      }
      return {
        ...saved,
        link: await linkWithHandy(at, owner, saved.link),
        filingContext: await filingContext(deps, owner),
        profile: await profileContext(deps, owner),
      };
    },
  );

  register(
    "update_link",
    {
      description: guidance.UPDATE_LINK,
      inputSchema: updateLinkInput,
      outputSchema: linkResultOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, snoozedUntil, handy, putAway, ...rest }) => {
      if (putAway && (rest.state !== undefined || rest.opened || handy)) {
        throw new CoreError("invalid_input", "putAway cannot be sent with state, handy or opened.");
      }
      // One instant for the handy write, the link write and the view, so an opening sent with an
      // answer lands at the answer's millisecond, never a jittered one after it.
      const now = deps.now();
      const at = { ...deps, now: () => now };
      // handy first, so a refused handy writes nothing. Past the schema, updateLink refuses only a
      // blank tag name (normalizeTags), a title over the limit (normalizeTitle) or a missing link,
      // so check the tags and the title before handy too.
      if (handy) {
        if (rest.tags) normalizeTags(rest.tags);
        if (rest.title !== undefined) normalizeTitle(rest.title);
        record({ kind: "handy", linkId: id, change: await applyHandy(at, owner, id, handy) });
      }
      const patch = {
        ...rest,
        ...(snoozedUntil !== undefined && {
          snoozedUntil: snoozedUntil === null ? null : new Date(snoozedUntil),
        }),
      };
      const changed = Object.keys(patch).filter(
        (k) => patch[k as keyof typeof patch] !== undefined,
      );
      if (putAway) {
        // Put away first: a link that is not active is refused before anything else is written.
        if (rest.tags) normalizeTags(rest.tags);
        if (rest.title !== undefined) normalizeTitle(rest.title);
        await putAwayLink(at, owner, id);
      }
      const { link, editId } =
        putAway && changed.length === 0
          ? { link: await getLink(at, owner, id), editId: null }
          : receipts
            ? await updateLinkWithReceipt(at, owner, id, patch, lastEdit.get(id))
            : { link: await updateLink(at, owner, id, patch), editId: null };
      remember(link.id, editId);
      const fields = putAway ? ["putAway", ...changed] : changed;
      if (fields.length > 0) {
        record({
          kind: "link",
          tool: "update_link",
          linkId: link.id,
          created: false,
          fields,
          editId,
        });
      }
      return { link: await linkWithHandy(at, owner, link) };
    },
  );

  register(
    "update_tag",
    {
      description: guidance.UPDATE_TAG,
      inputSchema: updateTagInput,
      outputSchema: updateTagOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, kind }) => {
      const tag = await changeTagKind(deps, owner, { name, kind });
      record({ kind: "tag", name: tag.name, tagKind: tag.kind });
      return { tag };
    },
  );

  register(
    "search_links",
    {
      description: guidance.SEARCH_LINKS,
      inputSchema: searchLinksInput,
      outputSchema: searchLinksOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ savedFrom, savedTo, ...rest }) => {
      const links = await searchLinks(
        deps,
        owner,
        { ...rest, savedFrom: toDate(savedFrom), savedTo: toDate(savedTo) },
        savedBy,
      );
      return { links: await linksWithHandy(deps, owner, links) };
    },
  );

  register(
    "list_links",
    {
      description: guidance.LIST_LINKS,
      inputSchema: listLinksInput,
      outputSchema: listLinksOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ savedFrom, savedTo, ...rest }) => {
      const { links, older, total } = await listLinks(deps, owner, {
        ...rest,
        savedFrom: toDate(savedFrom),
        savedTo: toDate(savedTo),
      });
      return { links: await linksWithHandy(deps, owner, links), total, nextCursor: older };
    },
  );

  register(
    "get_link",
    {
      description: guidance.GET_LINK,
      inputSchema: getLinkInput,
      outputSchema: getLinkOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const got = await getLinkWithText(deps, owner, id, savedBy);
      return { ...got, link: await linkWithHandy(deps, owner, got.link) };
    },
  );

  register(
    "get_profile",
    {
      description: guidance.GET_PROFILE,
      inputSchema: getProfileInput,
      outputSchema: getProfileOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => getProfile(deps, owner),
  );

  register(
    "add_profile",
    {
      description: guidance.ADD_PROFILE,
      inputSchema: addProfileInput,
      outputSchema: addProfileOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { added, ...written } = await addProfile(deps, owner, savedBy, args);
      record({
        kind: "profile",
        added: [...entries("note", added.notes), ...entries("focus", added.focus)],
        edited: [],
        removed: [],
      });
      return written;
    },
  );

  register(
    "edit_profile",
    {
      description: guidance.EDIT_PROFILE,
      inputSchema: editProfileInput,
      outputSchema: profileOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      const { removed, ...profile } = await editProfile(deps, owner, savedBy, args);
      const edited = new Set(args.editNotes?.map((e) => e.id));
      record({
        kind: "profile",
        added: [],
        edited: entries(
          "note",
          profile.notes.filter((n) => edited.has(n.id)),
        ),
        removed: entries("note", removed),
      });
      return profile;
    },
  );

  register(
    "get_digest",
    {
      description: guidance.GET_DIGEST,
      inputSchema: getDigestInput,
      outputSchema: getDigestOutput,
      // Not read-only or idempotent: each call marks the links it returns as surfaced.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      // One instant: getDigest reads now once and claims at it, so each item's handy uses that now too.
      const now = deps.now();
      const at = { ...deps, now: () => now };
      const { links, claimed } = await getDigest(at, owner);
      if (claimed.length > 0) record({ kind: "surfaced", linkIds: claimed });
      const handied = await linksWithHandy(
        at,
        owner,
        links.map((d) => d.link),
      );
      return { links: links.map((d, i) => ({ ...d, link: handied[i] as HandyLink })) };
    },
  );

  return server;
}
