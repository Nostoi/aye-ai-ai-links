import { createCimdClientDiscovery } from "@better-auth/cimd";
import {
  type ClientDiscovery,
  type ClientMetadataResourceFetch,
  extendOAuthProvider,
} from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";

/** The MCP profile cimd validates documents against; the stash validates with the same one. */
export const CIMD_METADATA_PROFILE = "mcp-2026-07-28" as const;

/**
 * Which URL client ids better-auth may resolve, and the memory-only transport cimd reads their
 * documents and key sets through.
 */
export type Admission = {
  isAdmitted: (clientId: string) => boolean;
  transport: ClientMetadataResourceFetch;
};

/** Admits nothing: for the owner CLI and tests, which never resolve a URL client. */
export const NO_ADMISSION: Admission = {
  isAdmitted: () => false,
  transport: async () => {
    throw new Error("no client metadata is available here");
  },
};

/**
 * cimd's own fetch budget counts requests before it checks anything, so unauthenticated
 * requests could use it up. Admission is the guard instead, and these limits never bind:
 * cimd only ever sees admitted ids, and its transport never touches the network.
 */
const UNBOUNDED_FETCH_POLICY = {
  minimumFetchInterval: 0,
  maximumConcurrentFetches: 1_000_000_000,
  maximumConcurrentFetchesPerOrigin: 1_000_000_000,
  maximumFetchesPerMinute: 1_000_000_000,
  maximumFetchesPerOriginPerMinute: 1_000_000_000,
};

/**
 * cimd's discovery with one change: `resolve` refuses a URL client id the admission does not
 * admit, before cimd does any caching or accounting. better-auth calls `resolve` for every
 * URL id a request names and for every stored cimd row, so nothing else reaches cimd.
 */
export function admittedDiscovery(admission: Admission): ClientDiscovery {
  const cimd = createCimdClientDiscovery({
    fetchClientMetadataResource: admission.transport,
    metadataProfile: CIMD_METADATA_PROFILE,
    metadataFetchPolicy: UNBOUNDED_FETCH_POLICY,
  });
  return {
    ...cimd,
    resolve: (ctx, clientId, existing) => {
      if (!admission.isAdmitted(clientId)) {
        throw new APIError("BAD_REQUEST", {
          error: "invalid_client",
          error_description: "client is not connected",
        });
      }
      return cimd.resolve(ctx, clientId, existing);
    },
  };
}

/** Contributes the admitted discovery in place of the `cimd()` plugin, which is never registered. */
export const clientAdmission = (admission: Admission) => {
  const clientDiscovery = admittedDiscovery(admission);
  return {
    id: "aye-client-admission",
    init(ctx) {
      extendOAuthProvider(ctx, { clientDiscovery });
    },
  } satisfies BetterAuthPlugin;
};
