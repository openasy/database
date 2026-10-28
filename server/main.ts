import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";
import { createMonitor } from "./monitor.ts";
import { connectPostgres } from "./postgres.ts";
import { parseProducts } from "./products.ts";
import { sealer } from "./seal.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.DATABASE_DB ?? "/data/database.db";
const retentionDays = Number(process.env.DATABASE_RETENTION_DAYS ?? 7);
const sampleSeconds = Number(process.env.DATABASE_SAMPLE_SECONDS ?? 60);
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.DATABASE_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.DATABASE_METRICS_PORT ? Number(process.env.DATABASE_METRICS_PORT) : undefined;

if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 90) throw new Error("DATABASE_RETENTION_DAYS must be a number of days, 1 to 90");
if (!Number.isInteger(sampleSeconds) || sampleSeconds < 10 || sampleSeconds > 3600)
  throw new Error("DATABASE_SAMPLE_SECONDS must be a whole number of seconds, 10 to 3600");

const db = openDb(dbPath);
// The address people open Database at, behind the TLS proxy (ADR 0026). Cookies, passkeys and OIDC redirects use it.
const publicUrl = (process.env.DATABASE_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.DATABASE_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const secretsKey = readSecretsKey(secretsKeyFile);
const auth = createAuth({
  db,
  product: "database",
  productName: "OpenAsy Database",
  origin: publicUrl,
  // Locally the same Database is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.DATABASE_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env, "DATABASE_"),
  secretsKey,
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });

const monitor = createMonitor(db, { sealer: sealer(secretsKey), connect: connectPostgres, retentionDays, sampleSeconds });
const server = createServer(
  createApp({
    db,
    monitor,
    version,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(monitor, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "database started", { version, port, db: dbPath, headless, retentionDays, sampleSeconds }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log("warn", "DATABASE_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys. Put Database behind TLS (ADR 0026)", {
    url: publicUrl,
  });
}
if (!secretsKey)
  log("warn", "no secrets key: no instance can be added, since Database keeps no database password unsealed. Mount a 32-byte key (openssl rand -hex 32)", {
    file: secretsKeyFile,
  });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

// One turn at a time: a slow instance must not have two samples of it run at once.
let sampling = false;
const sample = () => {
  if (sampling) return;
  sampling = true;
  void monitor
    .sampleAll()
    .catch((err: unknown) => log("error", "sampler", { error: String(err) }))
    .finally(() => (sampling = false));
};
monitor.purge();
sample();
const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  setInterval(() => monitor.purge(), 3_600_000),
  setInterval(sample, sampleSeconds * 1000),
];

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  metricsServer?.close();
  server.close(() => {
    void monitor.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
