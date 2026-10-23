import type { Database } from "better-sqlite3";

/**
 * Ordered and append-only: entry N takes the schema from version N-1 to N.
 *
 * `migrate()` runs with foreign keys off and checks them before it commits, so a
 * migration may rebuild a table (SQLite's 12-step procedure, steps 3-9). Two rules:
 * - Cascades do not run during a migration. One that removes parent rows must delete
 *   their child rows itself, or the foreign-key check refuses it.
 * - A rebuild of a table must drop every trigger whose SQL names it before the DROP and
 *   recreate them after the RENAME, copied from `sqlite_master` at the previous version
 * - A rebuild builds the new table beside the old one and renames it into place; it never
 *   renames the old table first. It reads the triggers and indexes from `sqlite_master`
 *   while it runs, so none that an earlier migration added is lost.
 * - A function migration carries its own SQL and calls no current app code, so databases upgraded
 *   at different times end with the same schema.
 */
export type Migration = string | ((db: Database) => void);

export const MIGRATIONS: Migration[] = [
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
  searchIndex(),
  `
  CREATE TABLE agent_keys (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );

  CREATE UNIQUE INDEX agent_keys_live_name ON agent_keys (owner_id, name) WHERE revoked_at IS NULL;
  `,
  snapshots(),
  // Profile notes and the focus log. Additive: no table is rebuilt, and neither has foreign-key
  // children. AUTOINCREMENT on notes so the id of a deleted note is never issued again.
  // Core trims and refuses blank text; the CHECK only guards the empty string.
  `
  CREATE TABLE profile_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    written_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (source IN ('stated', 'asked', 'inferred')),
    CHECK (text <> '')
  );
  CREATE INDEX profile_notes_owner ON profile_notes (owner_id, id);

  CREATE TABLE focus_log (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    written_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (source IN ('stated', 'asked', 'inferred')),
    CHECK (text <> '')
  );
  CREATE INDEX focus_log_owner_recent ON focus_log (owner_id, created_at DESC, id DESC);
  `,
  // The lease token (#30): moved by every lease, record and release, so a claim is never valid
  // twice. Additive; rebuilds nothing.
  "ALTER TABLE snapshots ADD COLUMN lease_token INTEGER NOT NULL DEFAULT 0",
  // Meaning-search vectors (#32): one float32 embedding per link and model. Additive; rebuilds nothing.
  `
  CREATE TABLE link_vectors (
    owner_id TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    model_key TEXT NOT NULL,
    dims INTEGER NOT NULL,
    text_hash TEXT NOT NULL,
    embedding BLOB NOT NULL,
    embedded_at INTEGER NOT NULL,
    PRIMARY KEY (link_id, model_key),
    FOREIGN KEY (owner_id, link_id) REFERENCES links(owner_id, id) ON DELETE CASCADE,
    CHECK (typeof(embedding) = 'blob' AND length(embedding) = dims * 4)
  );
  `,
  // The search log (#32): each word search and the link the same agent opened next, for tuning
  // meaning search. Additive; rebuilds nothing. No foreign key on the opened link: the log
  // outlives a deleted link, and the stored url keys show when an id was reused.
  `
  CREATE TABLE search_log (
    id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    searched_by TEXT NOT NULL,
    query TEXT NOT NULL CHECK (query <> ''),
    filters TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('keyword', 'hybrid', 'fallback')),
    embedded TEXT,
    model_key TEXT,
    meaning_candidates INTEGER NOT NULL,
    result_limit INTEGER NOT NULL CHECK (result_limit BETWEEN 1 AND 50),
    results TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    opened_link_id INTEGER,
    opened_url_key TEXT,
    opened_at INTEGER
  );
  CREATE INDEX search_log_pairing ON search_log (owner_id, searched_by, id);
  `,
  // Who decided a tag's kind (#45). The default is the backfill: for tags that already exist the
  // origin was not recorded, so each is shown as a guess. Additive; rebuilds nothing.
  `ALTER TABLE tags ADD COLUMN kind_source TEXT NOT NULL DEFAULT 'inferred'
    CHECK (kind_source IN ('stated', 'asked', 'inferred'))`,
  // Preview images the server keeps (#94). `image_status` is pending from when a snapshot is
  // recorded with an image URL until the image pass stores it or gives up; the backfill makes
  // every existing image URL pending. The byte cap is the image fetcher's 2 MiB. Additive;
  // rebuilds nothing.
  `
  ALTER TABLE snapshots ADD COLUMN image_status TEXT
    CHECK (image_status IN ('pending', 'ok', 'none', 'refused'));
  UPDATE snapshots SET image_status = 'pending' WHERE image_url IS NOT NULL;
  CREATE INDEX snapshots_image_pending ON snapshots (link_id) WHERE image_status = 'pending';

  CREATE TABLE link_images (
    owner_id TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    content_type TEXT NOT NULL
      CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    bytes BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, link_id),
    FOREIGN KEY (owner_id, link_id) REFERENCES links(owner_id, id) ON DELETE CASCADE,
    CHECK (typeof(bytes) = 'blob' AND length(bytes) <= 2097152)
  );
  `,
  // When a profile note was removed (#98): removal is soft, so Undo can bring the note back
  // until it is purged. NULL is a live note. Additive; rebuilds nothing.
  "ALTER TABLE profile_notes ADD COLUMN removed_at INTEGER",
  // Keep handy (#125): a link's tool row. A link with no row is an ordinary link. The composite
  // foreign key deletes the row with its link, as link_tags rows are. Additive; rebuilds nothing.
  `
  CREATE TABLE link_tools (
    owner_id TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('kept', 'suggested', 'declined')),
    source TEXT NOT NULL CHECK (source IN ('stated', 'asked', 'inferred')),
    since INTEGER NOT NULL,
    answered_at INTEGER,
    wait_days INTEGER NOT NULL CHECK (wait_days IN (30, 60, 120)),
    PRIMARY KEY (owner_id, link_id),
    FOREIGN KEY (owner_id, link_id) REFERENCES links(owner_id, id) ON DELETE CASCADE
  );
  `,
  // Editing a link's title and picture (#145). `owner_images` is the picture the owner set;
  // `link_images` stays the fetched one only, so a fetch can never overwrite the owner's. Same type
  // and 2 MiB checks as `link_images`. `link_edits` is what the last edit replaced and wrote, one
  // row per link, so its Undo acts only while nothing changed since. Both go with their link by
  // the composite foreign key. Additive; rebuilds nothing.
  `
  CREATE TABLE owner_images (
    owner_id TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    content_type TEXT NOT NULL
      CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    bytes BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    set_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, link_id),
    FOREIGN KEY (owner_id, link_id) REFERENCES links(owner_id, id) ON DELETE CASCADE,
    CHECK (typeof(bytes) = 'blob' AND length(bytes) <= 2097152)
  );

  CREATE TABLE link_edits (
    owner_id TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    edit_id TEXT NOT NULL,
    title_changed INTEGER NOT NULL CHECK (title_changed IN (0, 1)),
    picture_changed INTEGER NOT NULL CHECK (picture_changed IN (0, 1)),
    prior_title TEXT,
    written_title TEXT,
    prior_content_type TEXT
      CHECK (prior_content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    prior_bytes BLOB
      CHECK (prior_bytes IS NULL OR (typeof(prior_bytes) = 'blob' AND length(prior_bytes) <= 2097152)),
    prior_sha256 TEXT,
    prior_set_at INTEGER,
    written_sha256 TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, link_id),
    FOREIGN KEY (owner_id, link_id) REFERENCES links(owner_id, id) ON DELETE CASCADE,
    CHECK (title_changed = 1 OR picture_changed = 1),
    CHECK ((prior_bytes IS NULL) = (prior_sha256 IS NULL)
      AND (prior_bytes IS NULL) = (prior_content_type IS NULL)
      AND (prior_bytes IS NULL) = (prior_set_at IS NULL))
  );
  `,
  // Dead-link checks (#128): a link's last check and its flag. A link with no row has never been
  // checked; the due read counts its saved_at as its last check, so nothing is backfilled. The
  // composite foreign key deletes the row with its link, as link_tools rows are. Additive; rebuilds
  // nothing, and snapshots and link_images are not touched.
  `
  CREATE TABLE link_checks (
    owner_id TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,
    result TEXT NOT NULL CHECK (result IN ('alive', 'dead', 'unknown')),
    detail TEXT,
    first_dead_at INTEGER,
    flagged_at INTEGER,
    still_works_at INTEGER,
    PRIMARY KEY (owner_id, link_id),
    FOREIGN KEY (owner_id, link_id) REFERENCES links(owner_id, id) ON DELETE CASCADE,
    CHECK (flagged_at IS NULL OR first_dead_at IS NOT NULL)
  );
  `,
  // Saved copies (#135): one row per link that has had a copy attempt, one per numbered image of
  // a copy, and the library id the folder's marker must match. Rows are deleted with their link by
  // the composite foreign key, as link_images rows are; the files are the store's to delete.
  // Additive; rebuilds nothing.
  `
  CREATE TABLE saved_copies (
    owner_id TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('saving', 'ok', 'removed', 'none', 'failed', 'no_room', 'too_large')),
    made_at INTEGER,
    finished_at INTEGER,
    image_nonce TEXT,
    md_bytes INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    removed_at INTEGER,
    PRIMARY KEY (owner_id, link_id),
    FOREIGN KEY (owner_id, link_id) REFERENCES links(owner_id, id) ON DELETE CASCADE,
    CHECK ((made_at IS NOT NULL) = (status IN ('saving', 'ok', 'removed'))),
    CHECK ((removed_at IS NOT NULL) = (status = 'removed')),
    CHECK (md_bytes >= 0 AND bytes >= md_bytes)
  );

  CREATE TABLE saved_copy_images (
    owner_id TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    n INTEGER NOT NULL CHECK (n BETWEEN 1 AND 30),
    url TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK (status IN ('pending', 'saving', 'ok', 'none', 'refused', 'no_room', 'too_large')),
    content_type TEXT
      CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    size INTEGER,
    sha256 TEXT,
    PRIMARY KEY (owner_id, link_id, n),
    FOREIGN KEY (owner_id, link_id) REFERENCES saved_copies(owner_id, link_id) ON DELETE CASCADE,
    CHECK ((content_type IS NOT NULL) = (status IN ('saving', 'ok'))
      AND (size IS NOT NULL) = (status IN ('saving', 'ok'))
      AND (sha256 IS NOT NULL) = (status IN ('saving', 'ok')))
  );
  CREATE INDEX saved_copy_images_pending ON saved_copy_images (link_id, n) WHERE status = 'pending';

  CREATE TABLE saved_copy_library (
    only INTEGER PRIMARY KEY CHECK (only = 1),
    id TEXT NOT NULL
  );
  `,
  // Site icons (#149): two icon candidates per snapshot, and whether a fetched picture is the preview or the icon. Additive.
  `
  ALTER TABLE snapshots ADD COLUMN icon_url TEXT;
  ALTER TABLE snapshots ADD COLUMN icon_next_url TEXT;
  ALTER TABLE link_images ADD COLUMN role TEXT NOT NULL DEFAULT 'preview' CHECK (role IN ('preview', 'icon'));
  `,
  rebuildLinks,
  rebuildLinkEdits,
  // Put away (#198): when an archived link was put away, and when Tidy up last kept a link. Additive.
  `
  ALTER TABLE links ADD COLUMN put_away_at INTEGER;
  ALTER TABLE links ADD COLUMN tidy_kept_at INTEGER;
  `,
  // Who wrote each summary (#160). An existing summary stays unlabelled (NULL). link_edits gets the
  // same pair, so Undo puts the label back with the text.
  `
  ALTER TABLE links ADD COLUMN summary_source TEXT
    CHECK (summary_source IS NULL
      OR (summary IS NOT NULL AND summary_source IN ('stated', 'asked', 'inferred', 'server')));
  ALTER TABLE link_edits ADD COLUMN prior_summary_source TEXT;
  ALTER TABLE link_edits ADD COLUMN written_summary_source TEXT;
  `,
  // Stats (#161): a log of openings and set-asides, seeded from what links already store. Additive.
  `
  CREATE TABLE link_events (
    owner_id TEXT NOT NULL,
    link_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('opened', 'put_away', 'stale', 'not_now', 'not_handy')),
    at INTEGER NOT NULL,
    backfilled INTEGER NOT NULL DEFAULT 0 CHECK (backfilled IN (0, 1)),
    FOREIGN KEY (owner_id, link_id) REFERENCES links(owner_id, id) ON DELETE CASCADE
  );
  CREATE INDEX link_events_owner_at ON link_events (owner_id, at);
  CREATE INDEX link_events_link ON link_events (owner_id, link_id, kind, at);

  CREATE TABLE stats_meta (
    only INTEGER PRIMARY KEY CHECK (only = 1),
    tracking_since INTEGER NOT NULL
  );
  INSERT INTO stats_meta (only, tracking_since)
    VALUES (1, CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER));

  INSERT INTO link_events (owner_id, link_id, kind, at, backfilled)
    SELECT owner_id, id, 'opened', last_opened_at, 1 FROM links WHERE last_opened_at IS NOT NULL;
  INSERT INTO link_events (owner_id, link_id, kind, at, backfilled)
    SELECT owner_id, id, 'put_away', put_away_at, 1 FROM links
      WHERE state = 'archived' AND put_away_at IS NOT NULL;
  INSERT INTO link_events (owner_id, link_id, kind, at, backfilled)
    SELECT owner_id, link_id, 'not_handy', since, 1 FROM link_tools WHERE status = 'declined';
  `,
];

/**
 * Link edits widen (#181): `link_edits` also holds the summary, why and tags an AI edit changed,
 * and a row may now change any one of the five. Every row is copied with the new flags at 0.
 */
function rebuildLinkEdits(db: Database): void {
  const cols =
    "owner_id, link_id, edit_id, title_changed, picture_changed, prior_title, written_title, prior_content_type, prior_bytes, prior_sha256, prior_set_at, written_sha256, at";
  db.exec(`
    CREATE TABLE link_edits_new (
      owner_id TEXT NOT NULL,
      link_id INTEGER NOT NULL,
      edit_id TEXT NOT NULL,
      title_changed INTEGER NOT NULL CHECK (title_changed IN (0, 1)),
      picture_changed INTEGER NOT NULL CHECK (picture_changed IN (0, 1)),
      prior_title TEXT,
      written_title TEXT,
      prior_content_type TEXT
        CHECK (prior_content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
      prior_bytes BLOB
        CHECK (prior_bytes IS NULL OR (typeof(prior_bytes) = 'blob' AND length(prior_bytes) <= 2097152)),
      prior_sha256 TEXT,
      prior_set_at INTEGER,
      written_sha256 TEXT,
      at INTEGER NOT NULL,
      summary_changed INTEGER NOT NULL DEFAULT 0 CHECK (summary_changed IN (0, 1)),
      prior_summary TEXT,
      written_summary TEXT,
      why_changed INTEGER NOT NULL DEFAULT 0 CHECK (why_changed IN (0, 1)),
      prior_why_text TEXT,
      prior_why_source TEXT,
      written_why_text TEXT,
      written_why_source TEXT,
      tags_changed INTEGER NOT NULL DEFAULT 0 CHECK (tags_changed IN (0, 1)),
      prior_tags TEXT,
      written_tags TEXT,
      PRIMARY KEY (owner_id, link_id),
      FOREIGN KEY (owner_id, link_id) REFERENCES links(owner_id, id) ON DELETE CASCADE,
      CHECK (title_changed = 1 OR picture_changed = 1 OR summary_changed = 1
        OR why_changed = 1 OR tags_changed = 1),
      CHECK ((prior_bytes IS NULL) = (prior_sha256 IS NULL)
        AND (prior_bytes IS NULL) = (prior_content_type IS NULL)
        AND (prior_bytes IS NULL) = (prior_set_at IS NULL))
    );
    INSERT INTO link_edits_new (${cols}) SELECT ${cols} FROM link_edits;
    DROP TABLE link_edits;
    ALTER TABLE link_edits_new RENAME TO link_edits;`);
}

/** Links rebuild (#126): AUTOINCREMENT ids, so a deleted link's id is never reused, and `deleted_at`. */
function rebuildLinks(db: Database): void {
  const triggers = (
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY rowid")
      .all() as { name: string; sql: string }[]
  ).filter((t) => /\blinks\b/.test(t.sql));
  const indexes = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'links' AND sql IS NOT NULL",
    )
    .all() as { sql: string }[];
  const cols =
    "id, owner_id, url, url_key, title, summary, why_text, why_source, saved_at, saved_by, last_opened_at, last_surfaced_at, snoozed_until, state";
  db.exec(`
    CREATE TABLE links_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      deleted_at INTEGER,
      UNIQUE (owner_id, url_key),
      UNIQUE (owner_id, id),
      CHECK ((why_text IS NULL) = (why_source IS NULL)),
      CHECK (why_source IN ('stated', 'asked', 'inferred')),
      CHECK (state IN ('active', 'archived'))
    );
    INSERT INTO links_new (${cols}) SELECT ${cols} FROM links;`);
  for (const t of triggers) db.exec(`DROP TRIGGER ${t.name}`);
  db.exec("DROP TABLE links; ALTER TABLE links_new RENAME TO links;");
  for (const t of triggers) db.exec(t.sql);
  for (const i of indexes) db.exec(i.sql);
  db.exec("CREATE INDEX links_deleted ON links (deleted_at) WHERE deleted_at IS NOT NULL");
}

/**
 * Keyword index: one `link_search` row per link (rowid = links.id), rebuilt by
 * triggers from whichever links the changed row touches. Additive: no table is rebuilt.
 */
function searchIndex(): string {
  const insert = (ids: string) => `
    INSERT INTO link_search (rowid, owner_id, title, summary, why, tags)
    SELECT l.id, l.owner_id, coalesce(l.title, ''), coalesce(l.summary, ''), coalesce(l.why_text, ''),
      coalesce((SELECT group_concat(name, ' ') FROM
        (SELECT t.name AS name FROM link_tags lt JOIN tags t ON t.id = lt.tag_id AND t.owner_id = lt.owner_id
         WHERE lt.link_id = l.id ORDER BY lt.position)), '')
    FROM links l WHERE l.id IN (${ids});`;
  const refresh = (ids: string) => `
    DELETE FROM link_search WHERE rowid IN (${ids});${insert(ids)}`;
  const trigger = (name: string, event: string, ids: string) =>
    `CREATE TRIGGER ${name} AFTER ${event} BEGIN${refresh(ids)}\nEND;`;
  const tagLinks = "SELECT link_id FROM link_tags WHERE tag_id = NEW.id";
  return `
  CREATE VIRTUAL TABLE link_search USING fts5(
    owner_id UNINDEXED, title, summary, why, tags,
    tokenize = 'porter unicode61 remove_diacritics 2'
  );
  ${insert("SELECT id FROM links")}
  ${trigger("link_search_links_ins", "INSERT ON links", "SELECT NEW.id")}
  ${trigger("link_search_links_upd", "UPDATE ON links", "SELECT NEW.id")}
  CREATE TRIGGER link_search_links_del AFTER DELETE ON links BEGIN
    DELETE FROM link_search WHERE rowid = OLD.id;
  END;
  ${trigger("link_search_lt_ins", "INSERT ON link_tags", "SELECT NEW.link_id")}
  ${trigger("link_search_lt_upd", "UPDATE ON link_tags", "SELECT OLD.link_id UNION SELECT NEW.link_id")}
  ${trigger("link_search_lt_del", "DELETE ON link_tags", "SELECT OLD.link_id")}
  ${trigger("link_search_tags_upd", "UPDATE OF name ON tags", tagLinks)}
  `;
}

/** Page snapshots, and `snapshot_search`, a keyword index over the page's own text. */
function snapshots(): string {
  const row = (
    r: string,
  ) => `INSERT INTO snapshot_search (rowid, owner_id, title, description, text)
    VALUES (${r}.link_id, ${r}.owner_id, coalesce(${r}.title, ''), coalesce(${r}.description, ''), coalesce(${r}.text, ''));`;
  return `
  CREATE TABLE snapshots (
    link_id INTEGER PRIMARY KEY,
    owner_id TEXT NOT NULL,
    fetch_status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_fetch_at INTEGER,
    fetched_at INTEGER,
    title TEXT,
    description TEXT,
    image_url TEXT,
    text TEXT,
    last_error TEXT,
    FOREIGN KEY (owner_id, link_id) REFERENCES links(owner_id, id) ON DELETE CASCADE,
    CHECK (fetch_status IN ('pending', 'retrying', 'ok', 'failed', 'refused', 'not_html',
      'extract_timeout', 'extract_out_of_memory', 'extract_crashed'))
  );
  CREATE INDEX snapshots_due ON snapshots (next_fetch_at) WHERE next_fetch_at IS NOT NULL;

  CREATE VIRTUAL TABLE snapshot_search USING fts5(
    owner_id UNINDEXED, title, description, text,
    tokenize = 'porter unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER snapshot_search_ins AFTER INSERT ON snapshots BEGIN
    ${row("NEW")}
  END;
  CREATE TRIGGER snapshot_search_upd AFTER UPDATE OF title, description, text ON snapshots BEGIN
    DELETE FROM snapshot_search WHERE rowid = NEW.link_id;
    ${row("NEW")}
  END;
  CREATE TRIGGER snapshot_search_del AFTER DELETE ON snapshots BEGIN
    DELETE FROM snapshot_search WHERE rowid = OLD.link_id;
  END;

  INSERT INTO snapshots (link_id, owner_id, fetch_status, next_fetch_at)
    SELECT id, owner_id, 'pending', 0 FROM links;
  `;
}

export const LATEST_VERSION = MIGRATIONS.length;

/**
 * Bring the database up to date in one transaction; refuse one from a newer version.
 * Foreign keys must be on when called and are on again afterwards; they are off while
 * migrations run, and any violation left at the end rolls the whole upgrade back.
 */
export function migrate(db: Database, migrations: Migration[] = MIGRATIONS): void {
  if (db.inTransaction) {
    throw new Error(
      "migrate() cannot run inside a transaction: foreign keys cannot be turned off there. Call it outside any transaction.",
    );
  }
  if (db.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new Error(
      "migrate() needs foreign keys on to start: open the database with openDatabase(), or run PRAGMA foreign_keys = ON first.",
    );
  }
  db.pragma("foreign_keys = OFF");
  try {
    if (db.pragma("foreign_keys", { simple: true }) !== 0) {
      throw new Error("migrate() could not turn foreign keys off, so it did not start.");
    }
    db.transaction(() => {
      const current = db.pragma("user_version", { simple: true }) as number;
      if (current > migrations.length) {
        throw new Error(
          `Database schema version ${current} is newer than this code (${migrations.length}); upgrade the app.`,
        );
      }
      if (current === migrations.length) return;
      for (const m of migrations.slice(current)) {
        if (typeof m === "string") db.exec(m);
        else m(db);
      }
      if (!db.inTransaction) {
        throw new Error(
          "A migration ended the transaction itself, so its later statements were committed with foreign keys off and cannot be rolled back. Migrations must not contain BEGIN, COMMIT or ROLLBACK.",
        );
      }
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `Migration left ${violations.length} foreign key violation(s) and was rolled back. Delete child rows explicitly when removing parents. First: ${JSON.stringify(violations[0])}`,
        );
      }
      db.pragma(`user_version = ${migrations.length}`);
    }).immediate();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
