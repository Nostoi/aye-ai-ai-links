import type { Database } from "better-sqlite3";

/** Every login in the auth database: the owners a signed-in caller can be. Reads only. */
export function loginOwners(authDb: Database): { id: string; name: string }[] {
  return authDb.prepare(`SELECT id, name FROM "user" ORDER BY id`).all() as {
    id: string;
    name: string;
  }[];
}
