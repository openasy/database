// Starts the app on a random port for tests, with a fake PostgreSQL that answers what the test sets.
import { createHmac } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { openDb } from "./db.ts";
import { EngineError, type Check, type Engine, type Explained, type Replication, type Session, type Stats, type Target } from "./engine.ts";
import { createMonitor, type MonitorOptions } from "./monitor.ts";
import { sealer } from "./seal.ts";

export const ADMIN_TOKEN = "test-admin-token";
export const T0 = Date.parse("2026-10-28T02:00:00Z");

export const session = (pid: number, over: Partial<Session> = {}): Session => ({
  pid,
  database: "shop",
  user: "shop_app",
  application: "shop-api",
  backendType: "client backend",
  client: "10.0.0.5",
  state: "active",
  waitEvent: null,
  xactSeconds: 1,
  stateSeconds: 1,
  query: "SELECT 1",
  blockedBy: [],
  waitingFor: null,
  ...over,
});

export const stats = (over: Partial<Stats> = {}): Stats => ({
  role: "primary",
  connections: { total: 12, active: 3, idle: 8, idleInTransaction: 1, blocked: 0 },
  maxConnections: 100,
  xactTotal: 1000,
  blocksHit: 9900,
  blocksRead: 100,
  sizeBytes: 5e9,
  lagSeconds: null,
  waitEvents: { CPU: 2, "Lock: transactionid": 1 },
  statements: [],
  ...over,
});

/** What the fake server answers; a test changes it as it goes. `down` makes every call fail to connect. */
export interface FakeServer {
  check: Check;
  stats: Stats;
  sessions: Session[];
  replication: Replication;
  plan: unknown;
  down: string | null;
  /** The targets connected to, with the password opened, and the statements explained. */
  targets: Target[];
  explained: Array<{ sql: string; database: string }>;
}

export function fakeServer(): FakeServer {
  return {
    check: {
      version: "PostgreSQL 18.6",
      versionNum: 180006,
      role: "primary",
      superuser: false,
      monitor: true,
      statements: true,
      databases: ["postgres", "shop"],
      warnings: [],
    },
    stats: stats(),
    sessions: [],
    replication: { role: "primary", lagSeconds: null, standbys: [], slots: [] },
    plan: [{ Plan: { "Node Type": "Seq Scan", "Relation Name": "orders", Alias: "orders", "Startup Cost": 0, "Total Cost": 1887, "Plan Rows": 100 } }],
    down: null,
    targets: [],
    explained: [],
  };
}

export function fakeConnect(server: FakeServer) {
  return (target: Target): Engine => {
    server.targets.push(target);
    const up = async <T>(value: () => T): Promise<T> => {
      if (server.down) throw new EngineError("unreachable", server.down);
      return structuredClone(value());
    };
    return {
      check: () => up(() => server.check),
      stats: () => up(() => server.stats),
      sessions: () => up(() => server.sessions),
      replication: () => up(() => server.replication),
      explain: async (sql: string, database: string): Promise<Explained> => {
        await up(() => null);
        if (/nope/.test(sql)) throw new EngineError("refused", 'relation "nope" does not exist');
        server.explained.push({ sql, database });
        return { plan: server.plan, parameters: [...sql.matchAll(/\$\d+/g)].length };
      },
      close: async () => {},
    };
  };
}

export async function startApp(opts: Partial<AppOptions> & { version: string; monitorOptions?: Partial<MonitorOptions> }) {
  const db = openDb(":memory:");
  let now = T0;
  const server = fakeServer();
  const { monitorOptions, ...appOptions } = opts;
  const monitor = createMonitor(db, { sealer: sealer(Buffer.alloc(32, 5)), connect: fakeConnect(server), clock: () => now, ...monitorOptions });
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const http: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const base = `http://localhost:${(http.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "database", productName: "OpenAsy Database", origin: base });
  handler = createApp({ db, monitor, auth, adminToken: ADMIN_TOKEN, ...appOptions });
  const as =
    (token: string) =>
    (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
  const admin = as(ADMIN_TOKEN);
  const get = async (path: string) => (await (await admin(path)).json()) as any;
  const send = (method: string, path: string, body?: unknown) => admin(path, { method, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const close = () => new Promise<void>((resolve) => http.close(() => resolve()));

  /** The owner, signed in with a second factor, makes an API token for each role. */
  async function roles() {
    const jar = new Map<string, string>();
    const browser = async (path: string, body: unknown) => {
      const res = await fetch(base + path, {
        method: "POST",
        headers: { origin: base, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const i = pair!.indexOf("=");
        jar.set(pair!.slice(0, i), pair!.slice(i + 1));
      }
      return res;
    };
    const setup = new URL(auth.setupLink()!).searchParams.get("setup");
    await browser("/api/v1/auth/setup", { token: setup, name: "Olivia", email: "owner@example.com", password: "correct horse battery staple 42" });
    const { secret } = (await (await browser("/api/v1/auth/me/totp", {})).json()) as { secret: string };
    await browser("/api/v1/auth/me/totp/confirm", { code: totp(secret) });
    const token = async (role: string) => ((await (await browser("/api/v1/auth/tokens", { name: role, role })).json()) as { token: string }).token;
    return { admin: as(await token("admin")), editor: as(await token("editor")), viewer: as(await token("viewer")) };
  }

  return { db, monitor, auth, server, base, admin, get, send, close, roles, later: (ms: number) => (now += ms) };
}

function totp(secret: string) {
  const bits = [...secret].map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  return String((mac.readUInt32BE(mac[19]! & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
