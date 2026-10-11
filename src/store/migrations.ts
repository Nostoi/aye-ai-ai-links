import type { Database } from "better-sqlite3";

/** Ordered and append-only: entry N takes the schema from version N-1 to N. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    url TEXT NOT NULL,
    url_key TEXT NOT NULL,
    title TEXT,
    summary TEXT,
    why_text TEXT,
    why_source TEXT,
    saved_at INTEGER NOT NULL,
    saved_by TEXT NOT NULL,
    last_opened_at INTEGER,
    last_surfaced_at INTEGER,
    snoozed_until INTEGER,
    state TEXT NOT NULL,
    UNIQUE (owner_id, url_key),
    UNIQUE (owner_id, id),
    CHECK ((why_text IS NULL) = (why_source IS NULL)),
    CHECK (why_source IN ('stated', 'asked', 'inferred')),
    CHECK (state IN ('active', 'archived'))
  );

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    color TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    project_status TEXT,
    UNIQUE (owner_id, key),
    UNIQUE (owner_id, id),
    CHECK (kind IN ('topic', 'project')),
    CHECK (pinned IN (0, 1)),
    CHECK (project_status IN ('active', 'done'))
  );

  CREATE TABLE link_tags (
    owner_id TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    tag_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (link_id, tag_id),
    FOREIGN KEY (owner_id, link_id) REFERENCES links(owner_id, id) ON DELETE CASCADE,
    FOREIGN KEY (owner_id, tag_id) REFERENCES tags(owner_id, id),
    CHECK (source IN ('stated', 'asked', 'inferred'))
  );
  `,
];

export const LATEST_VERSION = MIGRATIONS.length;

/** Bring the database up to date in one transaction; refuse one from a newer version. */
export function migrate(db: Database, migrations: string[] = MIGRATIONS): void {
  db.transaction(() => {
    const current = db.pragma("user_version", { simple: true }) as number;
    if (current > migrations.length) {
      throw new Error(
        `Database schema version ${current} is newer than this code (${migrations.length}); upgrade the app.`,
      );
    }
    if (current === migrations.length) return;
    for (const sql of migrations.slice(current)) db.exec(sql);
    db.pragma(`user_version = ${migrations.length}`);
  }).immediate();
}
