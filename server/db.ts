import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `-- A database server Database watches, and how it signs in. The password is sealed with the install's key
   -- (ADR 0021) and never leaves the server again. The engine is postgresql in this release (ADR 0062).
   CREATE TABLE instances (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     engine TEXT NOT NULL,
     host TEXT NOT NULL,
     port INTEGER NOT NULL,
     database TEXT NOT NULL,
     username TEXT NOT NULL,
     password TEXT NOT NULL,
     tls TEXT NOT NULL CHECK (tls IN ('verify', 'require', 'disable')),
     ca TEXT,
     created_at TEXT NOT NULL,
     -- The last check: whether it answered, as what, and what to fix in its monitoring role.
     checked_at TEXT,
     ok INTEGER,
     error TEXT,
     version TEXT,
     role TEXT,
     databases TEXT NOT NULL DEFAULT '[]',
     warnings TEXT NOT NULL DEFAULT '[]'
   );
   -- What an instance looked like at one time: connections, rates since the sample before, lag and wait events.
   CREATE TABLE samples (
     instance_id TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
     at TEXT NOT NULL,
     role TEXT NOT NULL,
     connections INTEGER NOT NULL,
     max_connections INTEGER NOT NULL,
     active INTEGER NOT NULL,
     idle INTEGER NOT NULL,
     idle_in_transaction INTEGER NOT NULL,
     blocked INTEGER NOT NULL,
     xact_total REAL NOT NULL,
     blocks_hit REAL NOT NULL,
     blocks_read REAL NOT NULL,
     xact_per_second REAL,
     cache_hit REAL,
     size_bytes REAL NOT NULL,
     lag_seconds REAL,
     wait_events TEXT NOT NULL DEFAULT '{}',
     PRIMARY KEY (instance_id, at)
   );
   -- A statement by its normalized text in one database, with its counters at the last sample to take the next
   -- one's difference from.
   CREATE TABLE statements (
     instance_id TEXT NOT NULL REFERENCES instances (id) ON DELETE CASCADE,
     key TEXT NOT NULL,
     database TEXT NOT NULL,
     query TEXT NOT NULL,
     calls REAL NOT NULL,
     total_ms REAL NOT NULL,
     rows REAL NOT NULL,
     seen_at TEXT NOT NULL,
     PRIMARY KEY (instance_id, key)
   );
   -- What a statement did between two samples.
   CREATE TABLE statement_samples (
     instance_id TEXT NOT NULL,
     key TEXT NOT NULL,
     at TEXT NOT NULL,
     calls REAL NOT NULL,
     total_ms REAL NOT NULL,
     rows REAL NOT NULL,
     PRIMARY KEY (instance_id, key, at),
     FOREIGN KEY (instance_id, key) REFERENCES statements (instance_id, key) ON DELETE CASCADE
   );
   CREATE INDEX statement_samples_at ON statement_samples (instance_id, at)`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
