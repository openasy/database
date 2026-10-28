import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { EngineError, type Connect, type Engine, type Replication, type Session, type Stats, type Target, type Tls } from "./engine.ts";
import { blockingChains, type Chains } from "./locks.ts";
import { explainable, parsePlan, type Plan } from "./plan.ts";
import type { Sealer } from "./seal.ts";

export type ProblemCode =
  "invalid-token" | "invalid-json" | "invalid-body" | "not-found" | "conflict" | "not-configured" | "unreachable" | "query-failed" | "internal-error";

export class MonitorError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  constructor(status: number, code: ProblemCode, detail: string) {
    super(detail);
    this.status = status;
    this.code = code;
  }
}

const bad = (detail: string) => new MonitorError(422, "invalid-body", detail);
const notFound = (what: string) => new MonitorError(404, "not-found", `${what} does not exist.`);
const conflict = (detail: string) => new MonitorError(409, "conflict", detail);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The check (version, role, databases, what the monitoring role lacks) is run again this often. */
const CHECK_EVERY_MS = HOUR;
/** Statements kept per sample, the ones that took the most time since the sample before. */
const STATEMENTS_PER_SAMPLE = 200;
/** Points in a chart at most; longer ranges are averaged into this many. */
const POINTS = 240;

export interface InstanceStatus {
  checkedAt: string;
  ok: boolean;
  error: string | null;
  version: string | null;
  role: "primary" | "replica" | null;
  databases: string[];
  warnings: string[];
}

/** A database server. Its password is never part of it: it is sealed when saved and only opened to connect. */
export interface Instance {
  id: string;
  name: string;
  engine: "postgresql";
  host: string;
  port: number;
  database: string;
  user: string;
  tls: Tls;
  ca: string | null;
  createdAt: string;
  status: InstanceStatus | null;
}

export interface Sample {
  at: string;
  role: "primary" | "replica";
  connections: number;
  maxConnections: number;
  active: number;
  idle: number;
  idleInTransaction: number;
  blocked: number;
  xactPerSecond: number | null;
  cacheHit: number | null;
  sizeBytes: number;
  lagSeconds: number | null;
}

export interface InstanceSummary {
  id: string;
  name: string;
  host: string;
  version: string | null;
  role: "primary" | "replica" | null;
  ok: boolean | null;
  error: string | null;
  warnings: string[];
  latest: Sample | null;
  /** What active sessions waited on in the last hour, as a share of them. */
  waitEvents: Array<{ event: string; share: number }>;
}

export interface Summary {
  instances: InstanceSummary[];
  totals: { instances: number; unreachable: number; blocked: number; maxLagSeconds: number | null; xactPerSecond: number; sizeBytes: number };
  sampleSeconds: number;
}

export interface QueryStat {
  key: string;
  database: string;
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
  /** Its share of the time of every statement in the range, 0 to 1. */
  share: number;
}

export interface Point {
  at: string;
  calls: number;
  meanMs: number | null;
}

export interface MonitorOptions {
  sealer: Sealer;
  connect: Connect;
  clock?: () => number;
  retentionDays?: number;
  sampleSeconds?: number;
}

type Row = Record<string, SQLInputValue>;

const text = (v: unknown, name: string, max: number, fallback?: string): string => {
  if (v === undefined || v === null || v === "") {
    if (fallback === undefined) throw bad(`${name} is required.`);
    return fallback;
  }
  if (typeof v !== "string") throw bad(`${name} must be text.`);
  const t = v.trim();
  if (!t && fallback === undefined) throw bad(`${name} is required.`);
  if (t.length > max) throw bad(`${name} is at most ${max} characters.`);
  return t || fallback!;
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A host name, an IPv4 address or an IPv6 one, with nothing a connection string would read as more.
const HOST = /^[A-Za-z0-9._:%[\]-]+$/;
const TLS: Tls[] = ["verify", "require", "disable"];

/** Hours a range covers: an hour to the retention, as the screens offer them. */
function hoursOf(v: string | null, max: number): number {
  if (v === null || v === "") return 24;
  const h = Number(v);
  if (!Number.isInteger(h) || h < 1 || h > max) throw bad(`hours is a whole number, 1 to ${max}.`);
  return h;
}

/** At most POINTS points: consecutive ones averaged, and the worst kept for what should not be hidden. */
export function downsample<T extends object>(points: T[], worst: string[] = []): T[] {
  if (points.length <= POINTS) return points;
  const size = Math.ceil(points.length / POINTS);
  const out: T[] = [];
  for (let i = 0; i < points.length; i += size) {
    const chunk = points.slice(i, i + size) as Array<Record<string, unknown>>;
    const p: Record<string, unknown> = { ...chunk[0] };
    for (const [k, v] of Object.entries(chunk[0]!)) {
      if (typeof v !== "number" && v !== null) continue;
      const values = chunk.map((c) => c[k]).filter((x): x is number => typeof x === "number");
      p[k] = !values.length ? null : worst.includes(k) ? Math.max(...values) : values.reduce((s, x) => s + x, 0) / values.length;
    }
    out.push(p as T);
  }
  return out;
}

export function createMonitor(db: DatabaseSync, { sealer, connect, clock = Date.now, retentionDays = 7, sampleSeconds = 60 }: MonitorOptions) {
  const iso = (ms = clock()) => new Date(ms).toISOString();
  const engines = new Map<string, Engine>();

  // ---------------------------------------------------------------- instances

  function row(id: string): Row {
    const r = db.prepare("SELECT * FROM instances WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw notFound("The instance");
    return r;
  }

  const toInstance = (r: Row): Instance => ({
    id: r.id as string,
    name: r.name as string,
    engine: "postgresql",
    host: r.host as string,
    port: Number(r.port),
    database: r.database as string,
    user: r.username as string,
    tls: r.tls as Tls,
    ca: (r.ca as string | null) ?? null,
    createdAt: r.created_at as string,
    status: r.checked_at
      ? {
          checkedAt: r.checked_at as string,
          ok: r.ok === 1,
          error: (r.error as string | null) ?? null,
          version: (r.version as string | null) ?? null,
          role: (r.role as "primary" | "replica" | null) ?? null,
          databases: JSON.parse(r.databases as string) as string[],
          warnings: JSON.parse(r.warnings as string) as string[],
        }
      : null,
  });

  /** The engine of an instance, connected with its opened password; made again when the instance changes. */
  function engineFor(r: Row): Engine {
    let e = engines.get(r.id as string);
    if (!e) {
      let password: string;
      try {
        password = sealer.open(r.password as string);
      } catch {
        throw new MonitorError(503, "not-configured", "The password of this instance cannot be opened: mount the secrets key it was sealed with.");
      }
      const target: Target = {
        host: r.host as string,
        port: Number(r.port),
        database: r.database as string,
        user: r.username as string,
        password,
        tls: r.tls as Tls,
        ca: (r.ca as string | null) ?? null,
      };
      e = connect(target);
      engines.set(r.id as string, e);
    }
    return e;
  }

  async function forget(id: string) {
    const e = engines.get(id);
    engines.delete(id);
    await e?.close();
  }

  /** What engine errors mean for the API: the server could not be reached, or it refused the statement. */
  function failure(r: Row, err: unknown): MonitorError {
    if (err instanceof EngineError && err.kind === "refused") return new MonitorError(422, "query-failed", `${r.name as string} answered: ${err.message}`);
    if (err instanceof EngineError) return new MonitorError(502, "unreachable", `${r.name as string} could not be reached: ${err.message}`);
    throw err;
  }

  /** The fields of an instance from a request body; the password only when one is sent. */
  function fields(body: Record<string, unknown>, creating: boolean) {
    const name = text(body.name, "name", 63);
    if (!NAME.test(name)) throw bad("name is letters, digits, dots, dashes and underscores, such as db-prod-01.");
    const engine = body.engine ?? "postgresql";
    if (engine !== "postgresql") throw bad("engine is postgresql: MySQL and MariaDB are not supported yet.");
    const host = text(body.host, "host", 253);
    if (!HOST.test(host)) throw bad("host is a host name or an IP address.");
    const port = body.port ?? 5432;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) throw bad("port is a whole number, 1 to 65535.");
    const database = text(body.database, "database", 63, "postgres");
    const user = text(body.user, "user", 63);
    const tls = (body.tls ?? "verify") as Tls;
    if (!TLS.includes(tls)) throw bad("tls is verify, require or disable.");
    const ca = body.ca === undefined || body.ca === null || body.ca === "" ? null : text(body.ca, "ca", 32_000);
    if (ca && !ca.includes("-----BEGIN CERTIFICATE-----")) throw bad("ca is a PEM certificate, from -----BEGIN CERTIFICATE-----.");
    if (ca && tls !== "verify") throw bad("ca is only for tls verify.");
    let password: string | null = null;
    if (body.password !== undefined && body.password !== null && body.password !== "") {
      if (typeof body.password !== "string" || body.password.length > 1024) throw bad("password is text, at most 1024 characters.");
      password = body.password;
    } else if (creating) throw bad("password is required: the password of the monitoring role.");
    // ADR 0021: a password is kept sealed or not at all.
    if (password !== null && !sealer.ready)
      throw new MonitorError(503, "not-configured", "Mount a secrets key (openasy-kek) first: Database keeps no database password without one.");
    return { name, engine, host, port: port as number, database, user, tls, ca, password };
  }

  /** Connects and records what the instance is, or why it did not answer. */
  async function check(id: string): Promise<Instance> {
    const r = row(id);
    const at = iso();
    try {
      const c = await engineFor(r).check();
      db.prepare("UPDATE instances SET checked_at = ?, ok = 1, error = NULL, version = ?, role = ?, databases = ?, warnings = ? WHERE id = ?").run(
        at,
        c.version,
        c.role,
        JSON.stringify(c.databases),
        JSON.stringify(c.warnings),
        id,
      );
    } catch (err) {
      const message = err instanceof EngineError || err instanceof MonitorError ? err.message : `Could not connect: ${(err as Error).message}`;
      db.prepare("UPDATE instances SET checked_at = ?, ok = 0, error = ? WHERE id = ?").run(at, message.slice(0, 500), id);
    }
    return toInstance(row(id));
  }

  // ---------------------------------------------------------------- samples

  const keyOf = (database: string, query: string) => createHash("sha256").update(`${database}\0${query}`).digest("hex").slice(0, 16);

  /** Keeps one sample: rates against the sample before, and what each statement did since. */
  function record(id: string, s: Stats) {
    const at = iso();
    const prev = db.prepare("SELECT * FROM samples WHERE instance_id = ? ORDER BY at DESC LIMIT 1").get(id) as Row | undefined;
    const secs = prev ? (Date.parse(at) - Date.parse(prev.at as string)) / 1000 : 0;
    // A counter that went down was reset: no rate for this sample.
    const delta = (now: number, before: SQLInputValue | undefined) => (prev && secs > 0 && now >= Number(before) ? now - Number(before) : null);
    const xact = delta(s.xactTotal, prev?.xact_total);
    const hit = delta(s.blocksHit, prev?.blocks_hit);
    const read = delta(s.blocksRead, prev?.blocks_read);
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT OR REPLACE INTO samples (instance_id, at, role, connections, max_connections, active, idle, idle_in_transaction, blocked, xact_total,
           blocks_hit, blocks_read, xact_per_second, cache_hit, size_bytes, lag_seconds, wait_events) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        at,
        s.role,
        s.connections.total,
        s.maxConnections,
        s.connections.active,
        s.connections.idle,
        s.connections.idleInTransaction,
        s.connections.blocked,
        s.xactTotal,
        s.blocksHit,
        s.blocksRead,
        xact === null ? null : xact / secs,
        hit !== null && read !== null && hit + read > 0 ? hit / (hit + read) : null,
        s.sizeBytes,
        s.lagSeconds,
        JSON.stringify(s.waitEvents),
      );
      if (s.statements) {
        const before = db.prepare("SELECT calls, total_ms, rows FROM statements WHERE instance_id = ? AND key = ?");
        const save = db.prepare(
          `INSERT INTO statements (instance_id, key, database, query, calls, total_ms, rows, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (instance_id, key) DO UPDATE SET calls = excluded.calls, total_ms = excluded.total_ms, rows = excluded.rows, seen_at = excluded.seen_at`,
        );
        const moved: Array<{ key: string; calls: number; totalMs: number; rows: number }> = [];
        for (const c of s.statements) {
          const key = keyOf(c.database, c.query);
          const b = before.get(id, key) as Row | undefined;
          save.run(id, key, c.database, c.query, c.calls, c.totalMs, c.rows, at);
          // The instance's first sample is a baseline. After it, a statement not seen before is new since the sample
          // before: pg_stat_statements starts each entry, and one it evicted and took back, from zero. So does a reset.
          if (!b && !prev) continue;
          const d =
            !b || c.calls < Number(b.calls)
              ? { calls: c.calls, totalMs: c.totalMs, rows: c.rows }
              : { calls: c.calls - Number(b.calls), totalMs: Math.max(0, c.totalMs - Number(b.total_ms)), rows: Math.max(0, c.rows - Number(b.rows)) };
          if (d.calls > 0) moved.push({ key, ...d });
        }
        const add = db.prepare("INSERT OR REPLACE INTO statement_samples (instance_id, key, at, calls, total_ms, rows) VALUES (?, ?, ?, ?, ?, ?)");
        for (const m of moved.sort((a, b) => b.totalMs - a.totalMs).slice(0, STATEMENTS_PER_SAMPLE)) add.run(id, m.key, at, m.calls, m.totalMs, m.rows);
      }
      db.prepare("UPDATE instances SET ok = 1, error = NULL, role = ? WHERE id = ?").run(s.role, id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  async function sampleOne(id: string): Promise<boolean> {
    const r = row(id);
    if (!r.checked_at || r.ok !== 1 || clock() - Date.parse(r.checked_at as string) > CHECK_EVERY_MS) {
      if (!(await check(id)).status?.ok) return false;
    }
    try {
      record(id, await engineFor(row(id)).stats());
      return true;
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      db.prepare("UPDATE instances SET ok = 0, error = ?, checked_at = ? WHERE id = ?").run(err.message.slice(0, 500), iso(), id);
      return false;
    }
  }

  const toSample = (r: Row): Sample => ({
    at: r.at as string,
    role: r.role as "primary" | "replica",
    connections: Number(r.connections),
    maxConnections: Number(r.max_connections),
    active: Number(r.active),
    idle: Number(r.idle),
    idleInTransaction: Number(r.idle_in_transaction),
    blocked: Number(r.blocked),
    xactPerSecond: r.xact_per_second === null ? null : Number(r.xact_per_second),
    cacheHit: r.cache_hit === null ? null : Number(r.cache_hit),
    sizeBytes: Number(r.size_bytes),
    lagSeconds: r.lag_seconds === null ? null : Number(r.lag_seconds),
  });

  const latest = (id: string) => {
    const r = db.prepare("SELECT * FROM samples WHERE instance_id = ? ORDER BY at DESC LIMIT 1").get(id) as Row | undefined;
    return r ? toSample(r) : null;
  };

  async function live<T>(id: string, fn: (e: Engine) => Promise<T>): Promise<T> {
    const r = row(id);
    try {
      return await fn(engineFor(r));
    } catch (err) {
      throw failure(r, err);
    }
  }

  return {
    sampleSeconds,

    instances(): Instance[] {
      return (db.prepare("SELECT * FROM instances ORDER BY name").all() as Row[]).map(toInstance);
    },

    instance(id: string): Instance {
      return toInstance(row(id));
    },

    async createInstance(body: Record<string, unknown>): Promise<Instance> {
      const f = fields(body, true);
      const id = `in_${randomUUID().slice(0, 12)}`;
      try {
        db.prepare(
          "INSERT INTO instances (id, name, engine, host, port, database, username, password, tls, ca, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(id, f.name, f.engine, f.host, f.port, f.database, f.user, sealer.seal(f.password!), f.tls, f.ca, iso());
      } catch (err) {
        if (/UNIQUE/.test(String(err))) throw conflict("An instance with this name exists.");
        throw err;
      }
      return check(id);
    },

    /** Changes where and how it connects. The password stays as it was unless a new one is sent. */
    async updateInstance(id: string, body: Record<string, unknown>): Promise<Instance> {
      row(id);
      const f = fields(body, false);
      try {
        db.prepare("UPDATE instances SET name = ?, host = ?, port = ?, database = ?, username = ?, tls = ?, ca = ? WHERE id = ?").run(
          f.name,
          f.host,
          f.port,
          f.database,
          f.user,
          f.tls,
          f.ca,
          id,
        );
      } catch (err) {
        if (/UNIQUE/.test(String(err))) throw conflict("An instance with this name exists.");
        throw err;
      }
      if (f.password !== null) db.prepare("UPDATE instances SET password = ? WHERE id = ?").run(sealer.seal(f.password), id);
      await forget(id);
      return check(id);
    },

    async deleteInstance(id: string): Promise<void> {
      row(id);
      await forget(id);
      db.prepare("DELETE FROM instances WHERE id = ?").run(id);
    },

    check,

    /** Samples every instance at once; returns how many answered. */
    async sampleAll(): Promise<number> {
      const ids = (db.prepare("SELECT id FROM instances").all() as Row[]).map((r) => r.id as string);
      const results = await Promise.allSettled(ids.map(sampleOne));
      return results.filter((r) => r.status === "fulfilled" && r.value).length;
    },

    // ---------------------------------------------------------------- what the screens read

    summary(): Summary {
      const since = iso(clock() - HOUR);
      const instances = this.instances().map((i): InstanceSummary => {
        const counts: Record<string, number> = {};
        for (const s of db.prepare("SELECT wait_events FROM samples WHERE instance_id = ? AND at >= ?").all(i.id, since) as Row[]) {
          for (const [k, n] of Object.entries(JSON.parse(s.wait_events as string) as Record<string, number>)) counts[k] = (counts[k] ?? 0) + n;
        }
        const all = Object.values(counts).reduce((s, n) => s + n, 0);
        return {
          id: i.id,
          name: i.name,
          host: i.host,
          version: i.status?.version ?? null,
          role: i.status?.role ?? null,
          ok: i.status ? i.status.ok : null,
          error: i.status?.error ?? null,
          warnings: i.status?.warnings ?? [],
          latest: latest(i.id),
          waitEvents: Object.entries(counts)
            .map(([event, n]) => ({ event, share: n / all }))
            .sort((a, b) => b.share - a.share)
            .slice(0, 8),
        };
      });
      const lags = instances.map((i) => i.latest?.lagSeconds).filter((l): l is number => typeof l === "number");
      return {
        instances,
        totals: {
          instances: instances.length,
          unreachable: instances.filter((i) => i.ok === false).length,
          blocked: instances.reduce((s, i) => s + (i.latest?.blocked ?? 0), 0),
          maxLagSeconds: lags.length ? Math.max(...lags) : null,
          xactPerSecond: instances.reduce((s, i) => s + (i.latest?.xactPerSecond ?? 0), 0),
          sizeBytes: instances.reduce((s, i) => s + (i.latest?.sizeBytes ?? 0), 0),
        },
        sampleSeconds,
      };
    },

    series(id: string, hours: string | null): { samples: Sample[] } {
      row(id);
      const h = hoursOf(hours, retentionDays * 24);
      const rows = db.prepare("SELECT * FROM samples WHERE instance_id = ? AND at >= ? ORDER BY at").all(id, iso(clock() - h * HOUR)) as Row[];
      return { samples: downsample(rows.map(toSample), ["blocked", "lagSeconds", "connections"]) };
    },

    /** The statements that took the most time in the range, by their normalized text. */
    queries(id: string, q: { hours: string | null; database: string | null; sort: string | null }) {
      row(id);
      const h = hoursOf(q.hours, retentionDays * 24);
      const sort = q.sort ?? "total";
      if (!["total", "mean", "calls"].includes(sort)) throw bad("sort is total, mean or calls.");
      const from = iso(clock() - h * HOUR);
      const all = (
        db
          .prepare(
            `SELECT s.key, st.database, st.query, sum(s.calls) AS calls, sum(s.total_ms) AS total_ms, sum(s.rows) AS rows
               FROM statement_samples s JOIN statements st ON st.instance_id = s.instance_id AND st.key = s.key
              WHERE s.instance_id = ? AND s.at >= ? GROUP BY s.key`,
          )
          .all(id, from) as Row[]
      ).map((r) => ({
        key: r.key as string,
        database: r.database as string,
        query: r.query as string,
        calls: Number(r.calls),
        totalMs: Number(r.total_ms),
        meanMs: Number(r.calls) ? Number(r.total_ms) / Number(r.calls) : 0,
        rows: Number(r.rows),
        share: 0,
      }));
      const totalMs = all.reduce((s, x) => s + x.totalMs, 0);
      for (const x of all) x.share = totalMs ? x.totalMs / totalMs : 0;
      const databases = Object.entries(all.reduce<Record<string, number>>((m, x) => ((m[x.database] = (m[x.database] ?? 0) + 1), m), {}))
        .map(([database, count]) => ({ database, count }))
        .sort((a, b) => b.count - a.count);
      const by = { total: (x: QueryStat) => x.totalMs, mean: (x: QueryStat) => x.meanMs, calls: (x: QueryStat) => x.calls }[sort as "total"];
      const queries = all
        .filter((x) => !q.database || x.database === q.database)
        .sort((a, b) => by(b) - by(a))
        .slice(0, 100);
      const points = (
        db
          .prepare("SELECT at, sum(calls) AS calls, sum(total_ms) AS total_ms FROM statement_samples WHERE instance_id = ? AND at >= ? GROUP BY at ORDER BY at")
          .all(id, from) as Row[]
      ).map((r): Point => ({ at: r.at as string, calls: Number(r.calls), meanMs: Number(r.calls) ? Number(r.total_ms) / Number(r.calls) : null }));
      return { from, totalMs, statements: all.length, databases, queries, points: downsample(points) };
    },

    /** One statement over the range: how often it ran and how long it took each time. */
    query(id: string, key: string, hours: string | null) {
      row(id);
      const h = hoursOf(hours, retentionDays * 24);
      const st = db.prepare("SELECT database, query FROM statements WHERE instance_id = ? AND key = ?").get(id, key) as Row | undefined;
      if (!st) throw notFound("The query");
      const rows = db
        .prepare("SELECT at, calls, total_ms, rows FROM statement_samples WHERE instance_id = ? AND key = ? AND at >= ? ORDER BY at")
        .all(id, key, iso(clock() - h * HOUR)) as Row[];
      const calls = rows.reduce((s, r) => s + Number(r.calls), 0);
      const totalMs = rows.reduce((s, r) => s + Number(r.total_ms), 0);
      return {
        key,
        database: st.database as string,
        query: st.query as string,
        calls,
        totalMs,
        meanMs: calls ? totalMs / calls : 0,
        rows: rows.reduce((s, r) => s + Number(r.rows), 0),
        points: downsample(
          rows.map((r): Point => ({ at: r.at as string, calls: Number(r.calls), meanMs: Number(r.calls) ? Number(r.total_ms) / Number(r.calls) : null })),
        ),
      };
    },

    // ---------------------------------------------------------------- live, read from the instance when asked

    async locks(id: string): Promise<Chains> {
      return blockingChains(await live(id, (e) => e.sessions()));
    },

    async connections(
      id: string,
    ): Promise<{ sessions: Session[]; maxConnections: number | null; byApplication: Array<{ application: string; count: number }> }> {
      const sessions = (await live(id, (e) => e.sessions())).filter((s) => s.backendType === "client backend");
      const counts = new Map<string, number>();
      for (const s of sessions) counts.set(s.application, (counts.get(s.application) ?? 0) + 1);
      return {
        sessions,
        maxConnections: latest(id)?.maxConnections ?? null,
        byApplication: [...counts].map(([application, count]) => ({ application, count })).sort((a, b) => b.count - a.count),
      };
    },

    async replication(id: string): Promise<Replication> {
      return live(id, (e) => e.replication());
    },

    /** The plan of one statement, never run: EXPLAIN without ANALYZE, in a read-only transaction. */
    async explain(id: string, body: Record<string, unknown>): Promise<Plan & { database: string; parameters: number }> {
      const r = row(id);
      if (typeof body.sql !== "string") throw bad("sql is required: the statement to explain.");
      const statement = explainable(body.sql);
      if ("error" in statement) throw bad(statement.error);
      const database = text(body.database, "database", 63, r.database as string);
      const known = JSON.parse(r.databases as string) as string[];
      if (database !== r.database && !known.includes(database)) throw bad(`database is one of the instance's databases: ${known.join(", ") || r.database}.`);
      const explained = await live(id, (e) => e.explain(statement.sql, database));
      return { database, parameters: explained.parameters, ...parsePlan(explained.plan) };
    },

    /** For /metrics: each instance's state from its last sample. */
    gauges() {
      return this.summary().instances.map((i) => ({ name: i.name, up: i.ok === true, latest: i.latest }));
    },

    /** Deletes samples older than the retention. */
    purge(): number {
      const before = iso(clock() - retentionDays * 24 * HOUR);
      const a = db.prepare("DELETE FROM statement_samples WHERE at < ?").run(before).changes;
      const b = db.prepare("DELETE FROM samples WHERE at < ?").run(before).changes;
      const c = db.prepare("DELETE FROM statements WHERE seen_at < ?").run(before).changes;
      return Number(a) + Number(b) + Number(c);
    },

    async close() {
      await Promise.allSettled([...engines.keys()].map(forget));
    },
  };
}

export type Monitor = ReturnType<typeof createMonitor>;
