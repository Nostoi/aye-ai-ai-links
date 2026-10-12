import {
  McpServer,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Caller } from "../auth/caller.js";
import { CoreError } from "../core/errors.js";
import { filingContext } from "../core/filing-context.js";
import { getLink, saveLink, updateLink } from "../core/links.js";
import { addProfile, editProfile, getProfile, profileContext } from "../core/profile.js";
import type { ProfileStore } from "../core/profile-store.js";
import type { LinkSearch } from "../core/search.js";
import { searchLinks } from "../core/search-links.js";
import type { SnapshotRunner } from "../core/snapshot-runner.js";
import type { LinkStore } from "../core/store.js";
import { changeTagKind } from "../core/tag-kind.js";
import { SOURCES, STATES, TAG_KINDS } from "../core/types.js";
import * as guidance from "./guidance.js";
import {
  addProfileOutput,
  advertisedOpen,
  getProfileOutput,
  linkResultOutput,
  profileOutput,
  saveLinkOutput,
  searchLinksOutput,
  updateTagOutput,
} from "./output-schemas.js";

export type McpDeps = {
  store: LinkStore;
  search: LinkSearch;
  profile: ProfileStore;
  now: () => Date;
  snapshots?: Pick<SnapshotRunner, "kick"> | undefined;
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
const tags = z.array(z.object({ name: z.string(), source, kind: z.enum(TAG_KINDS).optional() }));

const saveLinkInput = z.object({
  url: z.string(),
  title: z.string().optional(),
  summary: z.string().optional(),
  why: why.optional(),
  tags: tags.optional(),
});
const updateLinkInput = z.object({
  id: z.string(),
  summary: z.string().nullable().optional(),
  why: why.nullable().optional(),
  tags: tags.optional(),
  state: z.enum(STATES).optional(),
  snoozedUntil: timestamp.nullable().optional(),
  opened: z.literal(true).optional(),
});
const searchLinksInput = z.object({
  query: z.string(),
  tag: z.string().optional(),
  project: z.string().optional(),
  savedFrom: timestamp.optional(),
  savedTo: timestamp.optional(),
  limit: z.number().optional(),
});
const updateTagInput = z.object({ name: z.string(), kind: z.enum(TAG_KINDS) });
const getLinkInput = z.object({ id: z.string() });
// A strict empty object advertises additionalProperties: false, the schema MCP recommends for a tool with no parameters.
const getProfileInput = z.strictObject({});
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

/** The caller comes from the authenticated request, never from tool arguments. */
export function buildMcpServer(
  deps: McpDeps,
  caller: Caller,
  track: TrackCall = (call) => call,
): McpServer {
  const server = new McpServer(
    { name: "aye-ai-ai-links", version: "0.1.0" },
    { instructions: guidance.INSTRUCTIONS },
  );
  const { owner, savedBy } = caller;

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
    async (args) => {
      const saved = await saveLink(deps, owner, { ...args, savedBy });
      return {
        ...saved,
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
    async ({ id, snoozedUntil, ...rest }) => ({
      link: await updateLink(deps, owner, id, {
        ...rest,
        ...(snoozedUntil !== undefined && {
          snoozedUntil: snoozedUntil === null ? null : new Date(snoozedUntil),
        }),
      }),
    }),
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
    async ({ name, kind }) => ({ tag: await changeTagKind(deps, owner, { name, kind }) }),
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
    async ({ savedFrom, savedTo, ...rest }) => ({
      links: await searchLinks(deps, owner, {
        ...rest,
        savedFrom: toDate(savedFrom),
        savedTo: toDate(savedTo),
      }),
    }),
  );

  register(
    "get_link",
    {
      description: guidance.GET_LINK,
      inputSchema: getLinkInput,
      outputSchema: linkResultOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => ({ link: await getLink(deps, owner, id) }),
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
    (args) => addProfile(deps, owner, savedBy, args),
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
    (args) => editProfile(deps, owner, savedBy, args),
  );

  return server;
}
