import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Caller } from "../auth/caller.js";
import { CoreError } from "../core/errors.js";
import { filingContext } from "../core/filing-context.js";
import { getLink, saveLink, updateLink } from "../core/links.js";
import type { LinkSearch } from "../core/search.js";
import { searchLinks } from "../core/search-links.js";
import type { LinkStore } from "../core/store.js";
import { changeTagKind } from "../core/tag-kind.js";
import { SOURCES, STATES, TAG_KINDS } from "../core/types.js";
import * as guidance from "./guidance.js";

export type McpDeps = { store: LinkStore; search: LinkSearch; now: () => Date };

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

async function guarded(run: () => Promise<unknown>) {
  try {
    return ok(await run());
  } catch (error) {
    return toFailure(error);
  }
}

/** The caller comes from the authenticated request, never from tool arguments. */
export function buildMcpServer(deps: McpDeps, caller: Caller): McpServer {
  const server = new McpServer(
    { name: "aye-ai-ai-links", version: "0.1.0" },
    { instructions: guidance.INSTRUCTIONS },
  );
  const { owner, savedBy } = caller;

  server.registerTool(
    "save_link",
    {
      description: guidance.SAVE_LINK,
      inputSchema: saveLinkInput,
      // Every hint is set: the spec defaults are destructive and open-world (https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args) =>
      guarded(async () => {
        const saved = await saveLink(deps, owner, { ...args, savedBy });
        return { ...saved, filingContext: await filingContext(deps, owner) };
      }),
  );

  server.registerTool(
    "update_link",
    {
      description: guidance.UPDATE_LINK,
      inputSchema: updateLinkInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ id, snoozedUntil, ...rest }) =>
      guarded(async () => ({
        link: await updateLink(deps, owner, id, {
          ...rest,
          ...(snoozedUntil !== undefined && {
            snoozedUntil: snoozedUntil === null ? null : new Date(snoozedUntil),
          }),
        }),
      })),
  );

  server.registerTool(
    "update_tag",
    {
      description: guidance.UPDATE_TAG,
      inputSchema: updateTagInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ name, kind }) =>
      guarded(async () => ({ tag: await changeTagKind(deps, owner, { name, kind }) })),
  );

  server.registerTool(
    "search_links",
    {
      description: guidance.SEARCH_LINKS,
      inputSchema: searchLinksInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ savedFrom, savedTo, ...rest }) =>
      guarded(async () => ({
        links: await searchLinks(deps, owner, {
          ...rest,
          savedFrom: toDate(savedFrom),
          savedTo: toDate(savedTo),
        }),
      })),
  );

  server.registerTool(
    "get_link",
    {
      description: guidance.GET_LINK,
      inputSchema: getLinkInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id }) => guarded(async () => ({ link: await getLink(deps, owner, id) })),
  );

  return server;
}
