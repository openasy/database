// The PostgreSQL engine against a real server: DATABASE_TEST_POSTGRES is a superuser's address, such as
// postgres://postgres:ci@127.0.0.1:5432/postgres, of a server started with shared_preload_libraries=pg_stat_statements.
// CI starts one; without it these tests are skipped. The superuser only sets up: everything Database reads, it reads
// as a role that is only in pg_monitor, as the README says to make.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import type { Engine, Target } from "./engine.ts";
import { blockingChains } from "./locks.ts";
import { createMonitor } from "./monitor.ts";
import { parsePlan } from "./plan.ts";
import { connectPostgres, engineError, tlsOptions } from "./postgres.ts";
import { sealer } from "./seal.ts";

const url = process.env.DATABASE_TEST_POSTGRES;
const DB = "openasy_test";
const ROLE = "openasy_test_monitor";
const PASSWORD = "monitor-test-password";

describe("tlsOptions and engineError", () => {
  it("verify the certificate and name by default", () => {
    expect(tlsOptions({ tls: "verify", ca: null, host: "db" })).toEqual({ rejectUnauthorized: true });
    expect(tlsOptions({ tls: "verify", ca: "PEM", host: "db" })).toEqual({ rejectUnauthorized: true, ca: "PEM" });
    expect(tlsOptions({ tls: "require", ca: null, host: "db" })).toEqual({ rejectUnauthorized: false });
    expect(tlsOptions({ tls: "disable", ca: null, host: "db" })).toBe(false);
  });

  it("tell a server that cannot be reached from one that refuses a statement", () => {
    expect(engineError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })).kind).toBe("unreachable");
    expect(engineError(Object.assign(new Error("password authentication failed"), { code: "28P01" })).kind).toBe("unreachable");
    expect(engineError(Object.assign(new Error('relation "x" does not exist'), { code: "42P01" })).kind).toBe("refused");
    expect(engineError(new Error("timeout expired")).kind).toBe("unreachable");
  });
});

describe.skipIf(!url)("PostgreSQL", () => {
  let admin: pg.Client;
  let engine: Engine;
  let target: Target;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE])).rowCount)
      await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}' IN ROLE pg_monitor`);
    if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB])).rowCount) await admin.query(`CREATE DATABASE ${DB}`);
    await admin.end();
    admin = new pg.Client({ connectionString: url!.replace(/\/[^/]*$/, `/${DB}`) });
    await admin.connect();
    await admin.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    await admin.query("DROP TABLE IF EXISTS orders");
    await admin.query("CREATE TABLE orders (id serial PRIMARY KEY, customer_id int NOT NULL, status text NOT NULL)");
    await admin.query("INSERT INTO orders (customer_id, status) SELECT g % 500, 'open' FROM generate_series(1, 20000) g");
    await admin.query("ANALYZE orders");
    // Explain plans what it is given, which takes the right to read the tables in it.
    await admin.query(`GRANT SELECT ON orders TO ${ROLE}`);
    const u = new URL(url!);
    target = { host: u.hostname, port: Number(u.port || 5432), database: DB, user: ROLE, password: PASSWORD, tls: "disable", ca: null };
    engine = connectPostgres(target);
  });

  afterAll(async () => {
    await engine?.close();
    await admin?.end();
  });

  it("checks what the server is and what the monitoring role may read", async () => {
    const c = await engine.check();
    expect(c.version).toMatch(/^PostgreSQL \d+/);
    expect(c.versionNum).toBeGreaterThanOrEqual(140000);
    expect(c).toMatchObject({ role: "primary", superuser: false, monitor: true, statements: true, warnings: [] });
    expect(c.databases).toContain(DB);
  });

  it("samples connections, counters and statements by their normalized text", async () => {
    for (const id of [1, 2, 3]) await admin.query("SELECT * FROM orders WHERE customer_id = $1", [id]);
    const s = await engine.stats();
    expect(s.role).toBe("primary");
    expect(s.maxConnections).toBeGreaterThan(0);
    expect(s.connections.total).toBeGreaterThanOrEqual(1);
    expect(s.xactTotal).toBeGreaterThan(0);
    expect(s.sizeBytes).toBeGreaterThan(0);
    const q = s.statements!.find((x) => x.query === "SELECT * FROM orders WHERE customer_id = $1");
    expect(q).toMatchObject({ database: DB });
    expect(q!.calls).toBeGreaterThanOrEqual(3);
    // Its own statements, such as this sample's, are left out: only other roles' runs of the same text count.
    const role = `(SELECT oid FROM pg_roles WHERE rolname = '${ROLE}')`;
    const own = (await admin.query(`SELECT query FROM pg_stat_statements WHERE userid = ${role} AND query LIKE '%pg_blocking_pids%' LIMIT 1`)).rows[0]
      .query as string;
    const others = (await admin.query(`SELECT COALESCE(sum(calls), 0)::int AS n FROM pg_stat_statements WHERE query = $1 AND userid <> ${role}`, [own])).rows[0]
      .n as number;
    expect(s.statements!.find((x) => x.query === own)?.calls ?? 0).toBe(others);
  });

  it("names the session at the head of a blocking chain", async () => {
    const holder = new pg.Client({ connectionString: url!.replace(/\/[^/]*$/, `/${DB}`), application_name: "migration" });
    const waiter = new pg.Client({ connectionString: url!.replace(/\/[^/]*$/, `/${DB}`), application_name: "orders-api" });
    await holder.connect();
    await waiter.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE orders IN ACCESS EXCLUSIVE MODE");
      const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      const waiting = waiter.query("SELECT count(*) FROM orders").catch(() => {});
      let chains = blockingChains([]);
      for (let n = 0; n < 50 && !chains.chains.length; n++) {
        await new Promise((r) => setTimeout(r, 50));
        chains = blockingChains(await engine.sessions());
      }
      expect(chains.chains[0]).toMatchObject({ pid: holderPid, application: "migration", state: "idle in transaction", blocking: 1 });
      expect(chains.chains[0]!.waiters[0]).toMatchObject({ application: "orders-api", waitingFor: "AccessShareLock on orders" });
      expect((await engine.stats()).connections.blocked).toBe(1);
      await holder.query("ROLLBACK");
      await waiting;
    } finally {
      await holder.end();
      await waiter.end();
    }
  });

  it("explains a statement with $1 as a generic plan, and plans without running", async () => {
    const e = await engine.explain("SELECT * FROM orders WHERE customer_id = $1", DB);
    expect(e.parameters).toBe(1);
    const plan = parsePlan(e.plan);
    expect(plan.root.op).toBe("Seq Scan on orders");
    expect(plan.root.detail[0]).toMatch(/^Filter: \(customer_id = \$1\)/);
    expect(plan.root.hot).toBe(true);
    // The role may read orders but not change it; planning an update needs the right to run it.
    await expect(engine.explain("UPDATE orders SET status = 'paid'", DB)).rejects.toMatchObject({ kind: "refused", message: /permission denied/ });
  });

  it("never runs more than one statement, even when one is smuggled in", async () => {
    await expect(engine.explain("SELECT 1; DROP TABLE orders", DB)).rejects.toMatchObject({ kind: "refused" });
    await expect(engine.explain("SELECT 1; COMMIT; SET default_transaction_read_only = off", DB)).rejects.toMatchObject({ kind: "refused" });
    expect((await admin.query("SELECT count(*)::int AS n FROM orders")).rows[0].n).toBe(20000);
  });

  it("reads replication slots and how much WAL they hold", async () => {
    await admin.query("SELECT pg_create_physical_replication_slot('openasy_test_slot', true)");
    try {
      const r = await engine.replication();
      expect(r).toMatchObject({ role: "primary", lagSeconds: null, standbys: [] });
      expect(r.slots.find((s) => s.name === "openasy_test_slot")).toMatchObject({ type: "physical", active: false });
    } finally {
      await admin.query("SELECT pg_drop_replication_slot('openasy_test_slot')");
    }
  });

  it("does not sign in with a wrong password, or without TLS when it is to verify", async () => {
    const wrong = connectPostgres({ ...target, password: "wrong" });
    await expect(wrong.check()).rejects.toMatchObject({ kind: "unreachable", message: /password authentication failed/ });
    await wrong.close();
    // This server has no TLS: verify, the default, refuses to go on without it.
    const verify = connectPostgres({ ...target, tls: "verify" });
    await expect(verify.check()).rejects.toMatchObject({ kind: "unreachable" });
    await verify.close();
  });

  it("is sampled by the monitor, end to end, with the password sealed", async () => {
    const db = openDb(":memory:");
    const monitor = createMonitor(db, { sealer: sealer(Buffer.alloc(32, 3)), connect: connectPostgres });
    const i = await monitor.createInstance({
      name: "test",
      host: target.host,
      port: target.port,
      database: DB,
      user: ROLE,
      password: PASSWORD,
      tls: "disable",
    });
    expect(i.status).toMatchObject({ ok: true, role: "primary" });
    expect(await monitor.sampleAll()).toBe(1);
    for (let n = 0; n < 5; n++) await admin.query("SELECT status FROM orders WHERE id = $1", [n]);
    expect(await monitor.sampleAll()).toBe(1);
    const q = monitor.queries(i.id, { hours: "1", database: DB, sort: "calls" });
    expect(q.queries.find((x) => x.query === "SELECT status FROM orders WHERE id = $1")).toMatchObject({ calls: 5 });
    const plan = await monitor.explain(i.id, { sql: "SELECT status FROM orders WHERE id = $1", database: DB });
    expect(plan.root.op).toBe("Index Scan using orders_pkey on orders");
    await monitor.close();
  });
});
