import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { session, startApp } from "./test-app.ts";

let app: Awaited<ReturnType<typeof startApp>>;
let as: Awaited<ReturnType<typeof app.roles>>;
const PASSWORD = "Tr0ub4dor-monitor-password";
const instance = { name: "db-prod-01", host: "db1.internal", user: "openasy_monitor", password: PASSWORD, tls: "verify" };

beforeAll(async () => {
  app = await startApp({ version: "0.1.0" });
  as = await app.roles();
});
afterAll(() => app.close());

describe("instances over the API", () => {
  it("are added by admins only, and the password is never sent back", async () => {
    expect((await as.editor("/api/v1/instances", { method: "POST", body: JSON.stringify(instance) })).status).toBe(403);
    const res = await as.admin("/api/v1/instances", { method: "POST", body: JSON.stringify(instance) });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(PASSWORD);
    expect(JSON.parse(text)).toMatchObject({ name: "db-prod-01", tls: "verify", status: { ok: true } });
    for (const path of ["/api/v1/instances", "/api/v1/summary", `/api/v1/instances/${JSON.parse(text).id}`])
      expect(await (await as.viewer(path)).text()).not.toContain(PASSWORD);
    expect(JSON.stringify(app.db.prepare("SELECT * FROM instances").all())).not.toContain(PASSWORD);
  });

  it("let viewers see locks and connections, and only editors explain", async () => {
    const [{ id }] = (await app.get("/api/v1/instances")).instances;
    app.server.sessions = [session(48211, { state: "idle in transaction", xactSeconds: 720 }), session(48302, { blockedBy: [48211] })];
    const locks = (await (await as.viewer(`/api/v1/instances/${id}/locks`)).json()) as any;
    expect(locks.chains[0]).toMatchObject({ pid: 48211, blocking: 1 });
    const explain = (fetcher: typeof as.viewer) => fetcher(`/api/v1/instances/${id}/explain`, { method: "POST", body: JSON.stringify({ sql: "SELECT 1" }) });
    expect((await explain(as.viewer)).status).toBe(403);
    expect((await explain(as.editor)).status).toBe(200);
    expect((await as.viewer(`/api/v1/instances/${id}/check`, { method: "POST" })).status).toBe(403);
  });

  it("tell an instance that does not answer apart, as a 502", async () => {
    const [{ id }] = (await app.get("/api/v1/instances")).instances;
    app.server.down = "connect ECONNREFUSED 10.0.0.1:5432";
    const res = await as.viewer(`/api/v1/instances/${id}/connections`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "unreachable", detail: "db-prod-01 could not be reached: connect ECONNREFUSED 10.0.0.1:5432" });
    app.server.down = null;
  });
});

describe("the product", () => {
  it("names itself, and has metrics for Prometheus with each instance's last sample", async () => {
    await app.monitor.sampleAll();
    expect(await (await fetch(`${app.base}/api/v1/version`)).json()).toEqual({ product: "database", version: "0.1.0" });
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toContain('openasy_build_info{product="database",version="0.1.0"} 1');
    expect(metrics).toContain("openasy_database_instances 1");
    expect(metrics).toContain('openasy_database_up{instance="db-prod-01"} 1');
    expect(metrics).toContain('openasy_database_connections{instance="db-prod-01"} 12');
    expect(metrics).toContain('openasy_database_sessions_idle_in_transaction{instance="db-prod-01"} 1');
    expect(metrics).not.toContain("openasy_database_replication_lag_seconds{");
  });

  it("sends the headers that keep the pages in their own frame and origin", async () => {
    const res = await fetch(`${app.base}/api/v1/version`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
