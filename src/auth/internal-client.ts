import { randomBytes } from "node:crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import type { Auth } from "./better-auth.js";

/** The fixed id of the confidential client `/mcp` introspects tokens through. */
export const INTERNAL_CLIENT_ID = "aye-introspect";

export type InternalClient = { clientId: string; clientSecret: string };

/**
 * Writes the internal client straight into better-auth's tables, with a new secret on every
 * start that is kept only in memory. It has no grant types and no redirect URIs, so it can
 * authenticate to introspection and nothing else. Its `oauthClientResource` link to `/mcp` is
 * what makes introspection report tokens for that resource as active.
 */
export async function installInternalClient(
  auth: Auth,
  resource: string,
  now: Date = new Date(),
): Promise<InternalClient> {
  const ctx = await auth.$context;
  const clientSecret = randomBytes(32).toString("base64url");
  const stored = await symmetricEncrypt({ key: ctx.secretConfig, data: clientSecret });
  const byId = [{ field: "clientId", value: INTERNAL_CLIENT_ID }];
  const fields = {
    clientSecret: stored,
    name: "Aye-AI-AI Links introspection",
    tokenEndpointAuthMethod: "client_secret_post",
    grantTypes: [],
    responseTypes: [],
    redirectUris: [],
    disabled: false,
    updatedAt: now,
  };
  await ctx.adapter.transaction(async (trx) => {
    if (await trx.findOne({ model: "oauthClient", where: byId })) {
      await trx.update({ model: "oauthClient", where: byId, update: fields });
    } else {
      await trx.create({
        model: "oauthClient",
        data: { clientId: INTERNAL_CLIENT_ID, ...fields, createdAt: now },
      });
    }
    const link = [...byId, { field: "resourceId", value: resource }];
    if (!(await trx.findOne({ model: "oauthClientResource", where: link }))) {
      await trx.create({
        model: "oauthClientResource",
        data: { clientId: INTERNAL_CLIENT_ID, resourceId: resource, createdAt: now },
      });
    }
  });
  return { clientId: INTERNAL_CLIENT_ID, clientSecret };
}
