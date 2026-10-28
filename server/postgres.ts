// PostgreSQL, read through its statistics views with node-postgres. Every session Database opens is read-only from
// its start, gives up on a statement after a few seconds and on a lock after one, so watching a database under load
// never becomes part of the load (ADR 0062).
import pg from "pg";
import {
  EngineError,
  type Check,
  type Connect,
  type Engine,
  type Explained,
  type Replication,
  type Session,
  type StatementCounter,
  type Stats,
  type Target,
} from "./engine.ts";

/** PostgreSQL 14 is the oldest the PostgreSQL project still supports. */
export const MIN_VERSION = 140000;

/** Statements read per sample: as many as pg_stat_statements keeps by default, so each one is read every time. */
const STATEMENTS = 5000;

// Set at the start of every session, before any statement: read-only, and short timeouts.
const OPTIONS = ["default_transaction_read_only=on", "statement_timeout=5000", "lock_timeout=1000", "idle_in_transaction_session_timeout=10000"]
  .map((o) => `-c ${o}`)
  .join(" ");

type Row = Record<string, unknown>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const orNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The TLS settings node-postgres takes: verify the certificate and the name by default (ADR 0013). */
export function tlsOptions(target: Pick<Target, "tls" | "ca" | "host">): pg.ClientConfig["ssl"] {
  if (target.tls === "disable") return false;
  if (target.tls === "require") return { rejectUnauthorized: false };
  return { rejectUnauthorized: true, ...(target.ca && { ca: target.ca }) };
}

/** A failure to reach or sign in to the server, or the server refusing what was sent. */
export function engineError(err: unknown): EngineError {
  const e = err as { code?: string; message?: string };
  const message = (e.message || String(err)).slice(0, 500);
  // SQLSTATE classes 08 (connection), 28 (authorization) and 3D (no such database), 57P (shutting down), and every
  // error with no SQLSTATE at all, such as a refused connection, a timeout or a certificate that does not verify.
  const sqlstate = typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
  if (!sqlstate || /^(08|28|3D|57P)/.test(sqlstate)) return new EngineError("unreachable", message);
  return new EngineError("refused", message);
}

export const connectPostgres: Connect = (target: Target): Engine => {
  const pools = new Map<string, pg.Pool>();

  function pool(database = target.database): pg.Pool {
    let p = pools.get(database);
    if (!p) {
      p = new pg.Pool({
        host: target.host,
        port: target.port,
        database,
        user: target.user,
        password: target.password,
        ssl: tlsOptions(target),
        application_name: "openasy-database",
        options: OPTIONS,
        max: database === target.database ? 2 : 1,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: database === target.database ? 120_000 : 30_000,
      });
      // An idle connection the server closes must not take the process down.
      p.on("error", () => {});
      pools.set(database, p);
    }
    return p;
  }

  async function rows(text: string, database?: string): Promise<Row[]> {
    try {
      return (await pool(database).query(text)).rows as Row[];
    } catch (err) {
      throw engineError(err);
    }
  }

  const one = async (text: string) => (await rows(text))[0] ?? {};

  async function statements(): Promise<StatementCounter[] | null> {
    const ready = await one("SELECT to_regclass('pg_stat_statements') IS NOT NULL AS ok");
    if (!ready.ok) return null;
    // Without pg_read_all_stats the text of other users' statements is hidden; they are left out rather than summed
    // as one. So are Database's own, run as its monitoring role, which would otherwise top the list.
    const list = await rows(`
      SELECT d.datname AS database, s.query, sum(s.calls)::float8 AS calls, sum(s.total_exec_time)::float8 AS total_ms,
             sum(s.rows)::float8 AS rows
        FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid
       WHERE s.query IS NOT NULL AND s.query <> '<insufficient privilege>'
         AND s.userid <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
       GROUP BY 1, 2 ORDER BY 4 DESC LIMIT ${STATEMENTS}`);
    return list.map((r) => ({ database: r.database as string, query: r.query as string, calls: num(r.calls), totalMs: num(r.total_ms), rows: num(r.rows) }));
  }

  const lag = `CASE WHEN pg_is_in_recovery() THEN
      CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
           ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())::float8 END
    ELSE (SELECT EXTRACT(EPOCH FROM max(replay_lag))::float8 FROM pg_stat_replication) END`;

  return {
    async check(): Promise<Check> {
      const r = await one(`
        SELECT current_setting('server_version_num')::int AS num, current_setting('server_version') AS version,
               pg_is_in_recovery() AS replica, r.rolsuper AS superuser,
               pg_has_role(current_user, 'pg_monitor', 'USAGE') AS monitor,
               to_regclass('pg_stat_statements') IS NOT NULL AS statements
          FROM pg_roles r WHERE r.rolname = current_user`);
      const versionNum = num(r.num);
      if (versionNum < MIN_VERSION) throw new EngineError("refused", `PostgreSQL ${String(r.version)} is older than 14, which Database needs.`);
      const databases = (await rows("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1")).map((d) => d.datname as string);
      const warnings: string[] = [];
      if (r.superuser) warnings.push("The role is a superuser. Give Database a role of its own that is only in pg_monitor.");
      if (!r.monitor && !r.superuser) warnings.push("The role is not in pg_monitor, so the queries of other sessions and users are hidden.");
      if (!r.statements)
        warnings.push(`pg_stat_statements is not installed in the database ${target.database}: run CREATE EXTENSION pg_stat_statements there to see queries.`);
      return {
        version: `PostgreSQL ${String(r.version).split(" ")[0]}`,
        versionNum,
        role: r.replica ? "replica" : "primary",
        superuser: Boolean(r.superuser),
        monitor: Boolean(r.monitor) || Boolean(r.superuser),
        statements: Boolean(r.statements),
        databases,
        warnings,
      };
    },

    async stats(): Promise<Stats> {
      const r = await one(`
        WITH a AS (
          SELECT state, wait_event_type, wait_event, cardinality(pg_blocking_pids(pid)) > 0 AS blocked
            FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
        )
        SELECT pg_is_in_recovery() AS replica,
               current_setting('max_connections')::int AS max_connections,
               (SELECT count(*)::int FROM a) AS total,
               (SELECT count(*)::int FROM a WHERE state = 'active') AS active,
               (SELECT count(*)::int FROM a WHERE state = 'idle') AS idle,
               (SELECT count(*)::int FROM a WHERE state LIKE 'idle in transaction%') AS idle_in_transaction,
               (SELECT count(*)::int FROM a WHERE blocked) AS blocked,
               (SELECT COALESCE(json_object_agg(w, n), '{}') FROM (
                  SELECT COALESCE(wait_event_type || ': ' || wait_event, 'CPU') AS w, count(*)::int AS n
                    FROM a WHERE state = 'active' GROUP BY 1) x) AS wait_events,
               (SELECT sum(xact_commit + xact_rollback)::float8 FROM pg_stat_database) AS xact_total,
               (SELECT sum(blks_hit)::float8 FROM pg_stat_database) AS blocks_hit,
               (SELECT sum(blks_read)::float8 FROM pg_stat_database) AS blocks_read,
               (SELECT sum(pg_database_size(oid))::float8 FROM pg_database WHERE datallowconn) AS size_bytes,
               ${lag} AS lag_seconds`);
      return {
        role: r.replica ? "replica" : "primary",
        connections: { total: num(r.total), active: num(r.active), idle: num(r.idle), idleInTransaction: num(r.idle_in_transaction), blocked: num(r.blocked) },
        maxConnections: num(r.max_connections),
        xactTotal: num(r.xact_total),
        blocksHit: num(r.blocks_hit),
        blocksRead: num(r.blocks_read),
        sizeBytes: num(r.size_bytes),
        lagSeconds: orNull(r.lag_seconds),
        waitEvents: (r.wait_events ?? {}) as Record<string, number>,
        statements: await statements(),
      };
    },

    async sessions(): Promise<Session[]> {
      const list = await rows(`
        SELECT a.pid, a.datname AS database, a.usename AS "user", a.application_name AS application,
               a.backend_type, host(a.client_addr) AS client, a.state,
               CASE WHEN a.wait_event IS NULL THEN NULL ELSE a.wait_event_type || ': ' || a.wait_event END AS wait_event,
               EXTRACT(EPOCH FROM now() - a.xact_start)::float8 AS xact_seconds,
               EXTRACT(EPOCH FROM now() - a.state_change)::float8 AS state_seconds,
               left(a.query, 2000) AS query, pg_blocking_pids(a.pid) AS blocked_by,
               (SELECT l.mode || ' on ' || COALESCE(l.relation::regclass::text, l.locktype)
                  FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted LIMIT 1) AS waiting_for
          FROM pg_stat_activity a
         WHERE a.pid <> pg_backend_pid() AND (a.backend_type = 'client backend' OR a.xact_start IS NOT NULL)
         ORDER BY a.pid`);
      return list.map((r) => ({
        pid: num(r.pid),
        database: (r.database as string | null) ?? null,
        user: (r.user as string | null) ?? null,
        application: (r.application as string | null) ?? "",
        backendType: (r.backend_type as string | null) ?? null,
        client: (r.client as string | null) ?? null,
        state: (r.state as string | null) ?? null,
        waitEvent: (r.wait_event as string | null) ?? null,
        xactSeconds: orNull(r.xact_seconds),
        stateSeconds: orNull(r.state_seconds),
        query: (r.query as string | null) ?? "",
        blockedBy: ((r.blocked_by as number[] | null) ?? []).map(Number),
        waitingFor: (r.waiting_for as string | null) ?? null,
      }));
    },

    async replication(): Promise<Replication> {
      const head = await one(`SELECT pg_is_in_recovery() AS replica, ${lag} AS lag_seconds`);
      // A replica has no WAL position of its own; it counts from what it has received.
      const lsn = head.replica ? "pg_last_wal_receive_lsn()" : "pg_current_wal_lsn()";
      const standbys = await rows(`
        SELECT application_name AS name, host(client_addr) AS client, state, sync_state,
               EXTRACT(EPOCH FROM write_lag)::float8 AS write_lag, EXTRACT(EPOCH FROM flush_lag)::float8 AS flush_lag,
               EXTRACT(EPOCH FROM replay_lag)::float8 AS replay_lag, pg_wal_lsn_diff(${lsn}, replay_lsn)::float8 AS behind
          FROM pg_stat_replication ORDER BY application_name`);
      const slots = await rows(`
        SELECT slot_name AS name, slot_type AS type, database, active, pg_wal_lsn_diff(${lsn}, restart_lsn)::float8 AS retained
          FROM pg_replication_slots ORDER BY slot_name`);
      return {
        role: head.replica ? "replica" : "primary",
        lagSeconds: orNull(head.lag_seconds),
        standbys: standbys.map((s) => ({
          name: (s.name as string) || "standby",
          client: (s.client as string | null) ?? null,
          state: (s.state as string | null) ?? null,
          syncState: (s.sync_state as string | null) ?? null,
          writeLagSeconds: orNull(s.write_lag),
          flushLagSeconds: orNull(s.flush_lag),
          replayLagSeconds: orNull(s.replay_lag),
          behindBytes: orNull(s.behind),
        })),
        slots: slots.map((s) => ({
          name: s.name as string,
          type: s.type as string,
          database: (s.database as string | null) ?? null,
          active: Boolean(s.active),
          retainedBytes: orNull(s.retained),
        })),
      };
    },

    async explain(sql: string, database: string): Promise<Explained> {
      let client: pg.PoolClient;
      try {
        client = await pool(database).connect();
      } catch (err) {
        throw engineError(err);
      }
      // Every statement goes over the extended protocol, which takes exactly one: nothing can follow the statement
      // being explained. PREPARE takes a statement with $1, $2 as pg_stat_statements shows it, and a generic plan
      // does not depend on their values, so EXECUTE passes nulls. EXPLAIN without ANALYZE plans and runs nothing.
      // node-postgres takes queryMode; its types do not list it yet.
      const q = (text: string) => client.query({ text, queryMode: "extended" } as pg.QueryConfig);
      try {
        await q("BEGIN READ ONLY");
        await q("SET LOCAL statement_timeout = 10000");
        await q("SET LOCAL plan_cache_mode = force_generic_plan");
        await q(`PREPARE openasy_explain AS ${sql}`);
        const p = ((await q("SELECT cardinality(parameter_types) AS n FROM pg_prepared_statements WHERE name = 'openasy_explain'")).rows[0] ?? {}) as Row;
        const parameters = num(p.n);
        const args = parameters ? `(${Array.from({ length: parameters }, () => "NULL").join(", ")})` : "";
        const r = await q(`EXPLAIN (FORMAT JSON) EXECUTE openasy_explain${args}`);
        return { plan: (r.rows[0] as Row | undefined)?.["QUERY PLAN"], parameters };
      } catch (err) {
        throw engineError(err);
      } finally {
        await q("ROLLBACK").catch(() => {});
        // A prepared statement outlives the transaction.
        await q("DEALLOCATE ALL").catch(() => {});
        client.release();
      }
    },

    async close() {
      await Promise.allSettled([...pools.values()].map((p) => p.end()));
      pools.clear();
    },
  };
};
