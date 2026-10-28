import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";

describe("openDb", () => {
  it("uses WAL and migrates once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "database-")), "nested", "database.db");
    const first = openDb(path);
    expect(first.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    first.close();
    const second = openDb(path);
    expect(second.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
    second.close();
  });

  it("keeps no sample of an instance that does not exist", () => {
    const db = openDb(":memory:");
    expect(() =>
      db
        .prepare(
          "INSERT INTO samples (instance_id, at, role, connections, max_connections, active, idle, idle_in_transaction, blocked, xact_total, blocks_hit, blocks_read, size_bytes) VALUES ('missing', 't', 'primary', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});
