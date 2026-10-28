import { describe, expect, it } from "vitest";
import { openDb } from "./db.ts";
import { createMonitor, downsample, MonitorError } from "./monitor.ts";
import { sealer } from "./seal.ts";
import { fakeConnect, fakeServer, session, stats, T0 } from "./test-app.ts";

const PASSWORD = "s3cret-monitor-password";
const shop = { name: "db-prod-01", host: "db1.internal", user: "openasy_monitor", password: PASSWORD };

function setup(key: Buffer | null = Buffer.alloc(32, 7)) {
  const db = openDb(":memory:");
  const server = fakeServer();
  let now = T0;
  const monitor = createMonitor(db, { sealer: sealer(key ?? undefined), connect: fakeConnect(server), clock: () => now });
  return { db, server, monitor, later: (ms: number) => (now += ms) };
}

describe("instances", () => {
  it("keep the password sealed, never return it, and open it only to connect", async () => {
    const { db, server, monitor } = setup();
    const i = await monitor.createInstance(shop);
    expect(i).toMatchObject({
      name: "db-prod-01",
      port: 5432,
      database: "postgres",
      tls: "verify",
      status: { ok: true, version: "PostgreSQL 18.6", role: "primary" },
    });
    expect(JSON.stringify(i)).not.toContain(PASSWORD);
    expect(JSON.stringify(monitor.instances())).not.toContain(PASSWORD);
    const stored = db.prepare("SELECT password FROM instances").get() as { password: string };
    expect(stored.password).toMatch(/^v1:/);
    expect(stored.password).not.toContain("s3cret");
    expect(server.targets[0]).toMatchObject({ host: "db1.internal", password: PASSWORD, tls: "verify" });
  });

  it("are refused without a secrets key, so no password is ever kept in the clear", async () => {
    const { monitor } = setup(null);
    await expect(monitor.createInstance(shop)).rejects.toMatchObject({ status: 503, code: "not-configured" });
    expect(monitor.instances()).toEqual([]);
  });

  it("check what they are given", async () => {
    const { monitor } = setup();
    const bad = (over: Record<string, unknown>) => monitor.createInstance({ ...shop, ...over });
    await expect(bad({ password: undefined })).rejects.toThrow(/password is required/);
    await expect(bad({ name: "db prod" })).rejects.toThrow(/name is/);
    await expect(bad({ host: "db1 host=evil" })).rejects.toThrow(/host is/);
    await expect(bad({ port: 70000 })).rejects.toThrow(/port is/);
    await expect(bad({ tls: "prefer" })).rejects.toThrow(/tls is/);
    await expect(bad({ engine: "mysql" })).rejects.toThrow(/not supported yet/);
    await expect(bad({ ca: "not a certificate" })).rejects.toThrow(/PEM/);
    await expect(bad({ tls: "require", ca: "-----BEGIN CERTIFICATE-----\nx" })).rejects.toThrow(/only for tls verify/);
    await monitor.createInstance(shop);
    await expect(monitor.createInstance(shop)).rejects.toMatchObject({ status: 409 });
  });

  it("keep their password when changed without one, and reconnect with a new one", async () => {
    const { db, server, monitor } = setup();
    const i = await monitor.createInstance(shop);
    const sealed = (db.prepare("SELECT password FROM instances").get() as { password: string }).password;
    await monitor.updateInstance(i.id, { ...shop, password: undefined, port: 6432 });
    expect((db.prepare("SELECT password FROM instances").get() as { password: string }).password).toBe(sealed);
    expect(server.targets.at(-1)).toMatchObject({ port: 6432, password: PASSWORD });
    await monitor.updateInstance(i.id, { ...shop, password: "new-one" });
    expect(server.targets.at(-1)!.password).toBe("new-one");
  });

  it("record why one does not answer, and keep it", async () => {
    const { server, monitor } = setup();
    server.down = 'password authentication failed for user "openasy_monitor"';
    const i = await monitor.createInstance(shop);
    expect(i.status).toMatchObject({ ok: false, error: 'password authentication failed for user "openasy_monitor"' });
    expect(monitor.instances()).toHaveLength(1);
    await expect(monitor.locks(i.id)).rejects.toMatchObject({ status: 502, code: "unreachable" });
    expect(await monitor.sampleAll()).toBe(0);
    server.down = null;
    expect(await monitor.sampleAll()).toBe(1);
    expect(monitor.instance(i.id).status).toMatchObject({ ok: true, error: null });
  });

  it("are deleted with what was sampled of them", async () => {
    const { db, monitor } = setup();
    const i = await monitor.createInstance(shop);
    await monitor.sampleAll();
    await monitor.deleteInstance(i.id);
    expect(db.prepare("SELECT count(*) AS n FROM samples").get()).toEqual({ n: 0 });
    expect(() => monitor.instance(i.id)).toThrow(MonitorError);
  });
});

describe("samples", () => {
  it("take rates from the sample before, and lag and connections as they are", async () => {
    const { server, monitor, later } = setup();
    const i = await monitor.createInstance(shop);
    await monitor.sampleAll();
    expect(monitor.summary().instances[0]!.latest).toMatchObject({ connections: 12, xactPerSecond: null, cacheHit: null });
    later(60_000);
    server.stats = stats({
      xactTotal: 7000,
      blocksHit: 19_800,
      blocksRead: 200,
      lagSeconds: 1.2,
      connections: { total: 40, active: 9, idle: 20, idleInTransaction: 11, blocked: 6 },
    });
    await monitor.sampleAll();
    const s = monitor.summary();
    expect(s.instances[0]!.latest).toMatchObject({ xactPerSecond: 100, cacheHit: 0.99, lagSeconds: 1.2, blocked: 6 });
    expect(s.totals).toMatchObject({ instances: 1, unreachable: 0, blocked: 6, maxLagSeconds: 1.2, xactPerSecond: 100 });
    expect(s.instances[0]!.waitEvents[0]).toEqual({ event: "CPU", share: 2 / 3 });
    expect(monitor.series(i.id, "1").samples).toHaveLength(2);
    // A reset of the statistics is not a negative rate.
    later(60_000);
    server.stats = stats({ xactTotal: 10 });
    await monitor.sampleAll();
    expect(monitor.summary().instances[0]!.latest!.xactPerSecond).toBeNull();
  });

  it("keep what each statement did between two samples, grouped by its normalized text", async () => {
    const { server, monitor, later } = setup();
    const i = await monitor.createInstance(shop);
    const slow = "SELECT * FROM orders WHERE customer_id = $1 AND status = $2";
    const fast = "SELECT 1";
    server.stats = stats({
      statements: [
        { database: "shop", query: slow, calls: 100, totalMs: 4000, rows: 300 },
        { database: "shop", query: fast, calls: 1000, totalMs: 100, rows: 1000 },
      ],
    });
    await monitor.sampleAll();
    // The first sample is a baseline.
    expect(monitor.queries(i.id, { hours: null, database: null, sort: null }).queries).toEqual([]);
    later(60_000);
    server.stats = stats({
      statements: [
        { database: "shop", query: slow, calls: 110, totalMs: 4400, rows: 330 },
        { database: "shop", query: fast, calls: 1500, totalMs: 150, rows: 1500 },
        { database: "accounts", query: fast, calls: 5, totalMs: 1, rows: 5 },
      ],
    });
    await monitor.sampleAll();
    later(60_000);
    server.stats = stats({
      statements: [
        { database: "shop", query: slow, calls: 120, totalMs: 4800, rows: 360 },
        { database: "shop", query: fast, calls: 1500, totalMs: 150, rows: 1500 },
        { database: "accounts", query: fast, calls: 9, totalMs: 2, rows: 9 },
      ],
    });
    await monitor.sampleAll();

    const q = monitor.queries(i.id, { hours: "24", database: null, sort: null });
    // accounts' statement was new in the second sample, after the baseline: all of its 5 calls count.
    expect(q.statements).toBe(3);
    expect(q.databases).toEqual([
      { database: "shop", count: 2 },
      { database: "accounts", count: 1 },
    ]);
    expect(q.queries[0]).toMatchObject({ database: "shop", query: slow, calls: 20, totalMs: 800, meanMs: 40, rows: 60 });
    expect(q.queries[0]!.share).toBeCloseTo(800 / 852, 5);
    expect(q.queries[1]).toMatchObject({ query: fast, database: "shop", calls: 500 });
    expect(q.queries[2]).toMatchObject({ query: fast, database: "accounts", calls: 9, totalMs: 2 });
    expect(q.points).toHaveLength(2);
    expect(monitor.queries(i.id, { hours: "24", database: "shop", sort: "calls" }).queries.map((x) => x.calls)).toEqual([500, 20]);
    expect(monitor.query(i.id, q.queries[0]!.key, null)).toMatchObject({ calls: 20, meanMs: 40, points: [{ calls: 10, meanMs: 40 }, { calls: 10 }] });
    expect(() => monitor.queries(i.id, { hours: "0", database: null, sort: null })).toThrow(/hours/);
    expect(() => monitor.queries(i.id, { hours: null, database: null, sort: "rows" })).toThrow(/sort/);
    expect(() => monitor.query(i.id, "missing", null)).toThrow(/does not exist/);
  });

  it("are purged after the retention", async () => {
    const { monitor, later } = setup();
    await monitor.createInstance(shop);
    await monitor.sampleAll();
    later(8 * 24 * 3_600_000);
    expect(monitor.purge()).toBe(1);
  });

  it("are averaged into at most 240 points, keeping the worst of some", () => {
    const points = Array.from({ length: 480 }, (_, n) => ({ at: String(n), blocked: n % 2 ? 9 : 1, connections: n % 2 ? 4 : 2 }));
    const out = downsample(points, ["blocked"]);
    expect(out).toHaveLength(240);
    expect(out[0]).toEqual({ at: "0", blocked: 9, connections: 3 });
  });
});

describe("live views", () => {
  it("show who blocks whom and every connection", async () => {
    const { server, monitor } = setup();
    const i = await monitor.createInstance(shop);
    await monitor.sampleAll();
    server.sessions = [
      session(10, { state: "idle in transaction", xactSeconds: 720, application: "flyway" }),
      session(11, { blockedBy: [10], stateSeconds: 700 }),
      session(12, { blockedBy: [10], stateSeconds: 30 }),
      session(13, { backendType: "autovacuum worker", application: "" }),
    ];
    const locks = await monitor.locks(i.id);
    expect(locks.chains.map((c) => [c.pid, c.application, c.blocking])).toEqual([[10, "flyway", 2]]);
    const c = await monitor.connections(i.id);
    expect(c.sessions.map((s) => s.pid)).toEqual([10, 11, 12]);
    expect(c.byApplication).toEqual([
      { application: "shop-api", count: 2 },
      { application: "flyway", count: 1 },
    ]);
    expect(c.maxConnections).toBe(100);
  });

  it("explain one statement in a database of the instance, and refuse the rest", async () => {
    const { server, monitor } = setup();
    const i = await monitor.createInstance(shop);
    const plan = await monitor.explain(i.id, { sql: "SELECT * FROM orders WHERE customer_id = $1;", database: "shop" });
    expect(plan).toMatchObject({ database: "shop", parameters: 1, totalCost: 1887, root: { op: "Seq Scan on orders", hot: true } });
    expect(server.explained).toEqual([{ sql: "SELECT * FROM orders WHERE customer_id = $1", database: "shop" }]);
    await expect(monitor.explain(i.id, { sql: "DROP TABLE orders" })).rejects.toMatchObject({ status: 422, code: "invalid-body" });
    await expect(monitor.explain(i.id, { sql: "SELECT 1", database: "other" })).rejects.toThrow(/postgres, shop/);
    await expect(monitor.explain(i.id, { sql: "SELECT * FROM nope" })).rejects.toMatchObject({ status: 422, code: "query-failed" });
    await expect(monitor.explain(i.id, {})).rejects.toThrow(/sql is required/);
    expect(server.explained).toHaveLength(1);
  });
});
