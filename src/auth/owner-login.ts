import { z } from "zod";
import type { Auth } from "./better-auth.js";
import { PASSWORD_LENGTH } from "./better-auth.js";

export class OwnerLoginError extends Error {}

/** Refuses a password sign-in would refuse, so the CLI never stores an unusable one. */
export function checkOwnerLogin(email: string, password: string): void {
  if (!z.email().safeParse(email).success) {
    throw new OwnerLoginError(`"${email}" is not an email address.`);
  }
  if (password.length < PASSWORD_LENGTH.min || password.length > PASSWORD_LENGTH.max) {
    throw new OwnerLoginError(
      `The password must be ${PASSWORD_LENGTH.min} to ${PASSWORD_LENGTH.max} characters long.`,
    );
  }
}

/**
 * Creates or updates the owner's user and its credential account, and deletes the owner's
 * sessions, all in one transaction. Writes only the `user`, `account` and `session` tables.
 * Returns whether the user was created.
 */
export async function setOwnerLogin(
  auth: Auth,
  who: { id: string; name: string; email: string; password: string },
  now: Date = new Date(),
): Promise<{ created: boolean }> {
  checkOwnerLogin(who.email, who.password);
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(who.password);
  return ctx.adapter.transaction(async (trx) => {
    const byId = [{ field: "id", value: who.id }];
    const existing = await trx.findOne({ model: "user", where: byId });
    if (existing) {
      await trx.update({
        model: "user",
        where: byId,
        update: { email: who.email, updatedAt: now },
      });
    } else {
      await trx.create({
        model: "user",
        data: {
          id: who.id,
          name: who.name,
          email: who.email,
          emailVerified: false,
          createdAt: now,
          updatedAt: now,
        },
        forceAllowId: true,
      });
    }
    // The same key better-auth's own password update matches: accountId is the user id.
    const credential = [
      { field: "userId", value: who.id },
      { field: "providerId", value: "credential" },
      { field: "accountId", value: who.id },
    ];
    const account = await trx.findOne({ model: "account", where: credential });
    if (account) {
      await trx.update({
        model: "account",
        where: credential,
        update: { password: hash, updatedAt: now },
      });
    } else {
      await trx.create({
        model: "account",
        data: {
          userId: who.id,
          providerId: "credential",
          accountId: who.id,
          password: hash,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    await trx.deleteMany({ model: "session", where: [{ field: "userId", value: who.id }] });
    return { created: !existing };
  });
}
