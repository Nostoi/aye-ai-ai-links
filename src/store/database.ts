import Database from "better-sqlite3";
import { migrate } from "./migrations.js";

/** Open (and migrate) the database. The caller owns the handle and must close it. */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = ON");
    if (path !== ":memory:") db.pragma("journal_mode = WAL");
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
