import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, session, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "database-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({ version, openapi: spec, docsDir });
  base = app.base;
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  // A response is either inline or a $ref to components/responses; build the JSON pointer to its schema either way.
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body };
}

const auth = (token: string, body?: string, type = "application/json") => ({
  headers: { authorization: `Bearer ${token}`, "content-type": type },
  ...(body !== undefined && { body }),
});
const admin = (body?: unknown) => auth(ADMIN_TOKEN, body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    // Database's own operations, then sign-in from @openasy/auth (tested against its description in that package).
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    const res = await fetch(`${base}/api/docs/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });
});

describe("responses match openapi.json", () => {
  let id = "";
  let key = "";
  const instance = { name: "db-prod-01", host: "db1.internal", user: "openasy_monitor", password: "secret" };

  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("instances", async () => {
    id = ((await call("POST", "/api/v1/instances", admin(instance))).body as { id: string }).id;
    await call("POST", "/api/v1/instances", admin(instance));
    await call("POST", "/api/v1/instances", admin({ ...instance, name: "x", tls: "prefer" }));
    await call("POST", "/api/v1/instances", admin("nope"));
    await call("POST", "/api/v1/instances", { method: "POST" });
    await call("GET", "/api/v1/instances", admin());
    await call("GET", "/api/v1/instances", {});
    const one = "/api/v1/instances/{id}";
    await call("GET", one, admin(), `/api/v1/instances/${id}`);
    await call("GET", one, admin(), "/api/v1/instances/missing");
    await call("GET", one, {}, `/api/v1/instances/${id}`);
    await call("PUT", one, admin({ ...instance, password: undefined, port: 6432 }), `/api/v1/instances/${id}`);
    await call("PUT", one, admin({ ...instance, port: 0 }), `/api/v1/instances/${id}`);
    await call("PUT", one, admin("nope"), `/api/v1/instances/${id}`);
    await call("PUT", one, admin(instance), "/api/v1/instances/missing");
    await call("PUT", one, { method: "PUT" }, `/api/v1/instances/${id}`);
    const other = ((await call("POST", "/api/v1/instances", admin({ ...instance, name: "db-prod-02" }))).body as { id: string }).id;
    await call("PUT", one, admin({ ...instance, name: "db-prod-02" }), `/api/v1/instances/${id}`);
    await call("DELETE", one, admin(), `/api/v1/instances/${other}`);
    await call("DELETE", one, admin(), "/api/v1/instances/missing");
    await call("DELETE", one, { method: "DELETE" }, `/api/v1/instances/${id}`);
    const check = "/api/v1/instances/{id}/check";
    await call("POST", check, { method: "POST", ...admin() }, `/api/v1/instances/${id}/check`);
    await call("POST", check, { method: "POST", ...admin() }, "/api/v1/instances/missing/check");
    await call("POST", check, { method: "POST" }, `/api/v1/instances/${id}/check`);
  });

  it("statistics", async () => {
    app.server.stats.statements = [{ database: "shop", query: "SELECT * FROM orders WHERE id = $1", calls: 10, totalMs: 20, rows: 10 }];
    await app.monitor.sampleAll();
    app.later(60_000);
    app.server.stats = {
      ...app.server.stats,
      xactTotal: 4000,
      statements: [{ database: "shop", query: "SELECT * FROM orders WHERE id = $1", calls: 30, totalMs: 80, rows: 30 }],
    };
    await app.monitor.sampleAll();
    await call("GET", "/api/v1/summary", admin());
    await call("GET", "/api/v1/summary", {});
    const series = "/api/v1/instances/{id}/series";
    await call("GET", series, admin(), `/api/v1/instances/${id}/series`);
    await call("GET", series, admin(), `/api/v1/instances/${id}/series?hours=0`);
    await call("GET", series, admin(), "/api/v1/instances/missing/series");
    await call("GET", series, {}, `/api/v1/instances/${id}/series`);
    const queries = "/api/v1/instances/{id}/queries";
    const list = (await call("GET", queries, admin(), `/api/v1/instances/${id}/queries?hours=24&database=shop&sort=mean`)).body as {
      queries: Array<{ key: string }>;
    };
    key = list.queries[0]!.key;
    await call("GET", queries, admin(), `/api/v1/instances/${id}/queries?sort=rows`);
    await call("GET", queries, admin(), "/api/v1/instances/missing/queries");
    await call("GET", queries, {}, `/api/v1/instances/${id}/queries`);
    const query = "/api/v1/instances/{id}/queries/{key}";
    await call("GET", query, admin(), `/api/v1/instances/${id}/queries/${key}`);
    await call("GET", query, admin(), `/api/v1/instances/${id}/queries/${key}?hours=nope`);
    await call("GET", query, admin(), `/api/v1/instances/${id}/queries/missing`);
    await call("GET", query, {}, `/api/v1/instances/${id}/queries/${key}`);
  });

  it("live views, and an instance that does not answer", async () => {
    app.server.sessions = [
      session(1, { state: "idle in transaction", xactSeconds: 60 }),
      session(2, { blockedBy: [1], waitingFor: "AccessShareLock on orders" }),
    ];
    app.server.replication = {
      role: "primary",
      lagSeconds: 0.2,
      standbys: [
        {
          name: "db-prod-02",
          client: "10.0.0.2",
          state: "streaming",
          syncState: "async",
          writeLagSeconds: 0.1,
          flushLagSeconds: 0.1,
          replayLagSeconds: 0.2,
          behindBytes: 4096,
        },
      ],
      slots: [{ name: "old_etl", type: "logical", database: "shop", active: false, retainedBytes: 38e9 }],
    };
    for (const view of ["locks", "connections", "replication"]) {
      const path = `/api/v1/instances/{id}/${view}`;
      await call("GET", path, admin(), `/api/v1/instances/${id}/${view}`);
      await call("GET", path, admin(), `/api/v1/instances/missing/${view}`);
      await call("GET", path, {}, `/api/v1/instances/${id}/${view}`);
    }
    const explain = "/api/v1/instances/{id}/explain";
    const at = `/api/v1/instances/${id}/explain`;
    await call("POST", explain, admin({ sql: "SELECT * FROM orders WHERE id = $1", database: "shop" }), at);
    await call("POST", explain, admin({ sql: "DROP TABLE orders" }), at);
    await call("POST", explain, admin({ sql: "SELECT * FROM nope" }), at);
    await call("POST", explain, admin("nope"), at);
    await call("POST", explain, admin({ sql: "SELECT 1" }), "/api/v1/instances/missing/explain");
    await call("POST", explain, { method: "POST" }, at);
    app.server.down = "connect ECONNREFUSED 10.0.0.1:5432";
    await call("GET", "/api/v1/instances/{id}/locks", admin(), `/api/v1/instances/${id}/locks`);
    await call("POST", explain, admin({ sql: "SELECT 1" }), at);
    await call("POST", "/api/v1/instances/{id}/check", { method: "POST", ...admin() }, `/api/v1/instances/${id}/check`);
    await call("GET", "/api/v1/summary", admin());
    app.server.down = null;
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
