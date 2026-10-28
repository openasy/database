# database

[![CI](https://github.com/openasy/database/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/database/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Database product: **why the database is slow** (ADR 0062). Most slow
applications are waiting on their database: a query without an index, a lock held by a forgotten transaction, a
replica behind, connections running out. The answers are in PostgreSQL's own statistics; Database reads them all the
time with a monitoring role, keeps them, and shows the slowest queries, who blocks whom, replication lag, connections
and query plans. It changes nothing on the databases it watches.

```
PostgreSQL 14+ ──pg_stat_statements, pg_stat_activity, pg_locks,──▶  database  ──▶ Queries, Locks, Replication,
  (a role in pg_monitor)   pg_stat_replication, EXPLAIN                    │         Connections, Explain
                                                                           └──▶ /metrics ──▶ Prometheus, Alerts
```

## What it reads

Every minute (`DATABASE_SAMPLE_SECONDS`), from each instance:

- **Statements** from `pg_stat_statements`, grouped by their normalized text and database, with what each did since
  the sample before: calls, time and rows. The first sample is a baseline; queries show from the second.
  Database's own statements are left out.
- **Connections** from `pg_stat_activity`: active, idle, idle in a transaction, and waiting on a lock, with what
  active sessions wait on; transactions per second and cache hits from `pg_stat_database`; the size of every database.
- **Lag**: a replica's delay behind its primary, or a primary's furthest standby.

When a screen asks, and never stored:

- **Locks**: who blocks whom, from `pg_blocking_pids()`. Each blocking chain starts at the session at its head, the
  one the others wait behind, often a transaction left idle; a session the role cannot see, or a worker such as
  autovacuum, heads its chain too.
- **Connections**: every client session, its state, how long, what it waits on and its last statement.
- **Replication**: standbys with their write, flush and replay lag, and replication slots with the WAL they keep. An
  inactive slot that keeps more than 1 GB is called out.
- **Explain**: the plan of a statement, `EXPLAIN` without `ANALYZE`, each node with its share of the cost and the
  costliest marked. Statements from Queries keep their `$1`, `$2`: they are prepared and planned as a generic plan.

## Changes nothing

- Every session Database opens starts read-only (`default_transaction_read_only`), gives up on a statement after 5
  seconds and on a lock after 1, so watching a database under load does not add to the load, and a migration holding
  a lock does not get a queue of Database's statements behind it.
- Explain takes one `SELECT`, `WITH`, `VALUES`, `TABLE`, `INSERT`, `UPDATE`, `DELETE` or `MERGE`. It is sent over the
  extended protocol, which takes exactly one statement, in a `READ ONLY` transaction that is rolled back, and is
  planned, never run. Only editors may explain.
- Terminating a session, dropping a slot and creating an index are for a DBA to do; the screens say what to look at.

## Credentials

An instance's password is sealed with the install's key (`openasy-kek`, AES-256-GCM, ADR 0021) before it is saved,
opened only to connect, and never sent back by the API or shown again: a change without a password keeps the one
saved. Without a key mounted, Database starts, but refuses to add an instance rather than keep a password in the
clear. TLS to PostgreSQL verifies the certificate and the host name by default; a PEM certificate authority can be
given per instance, and `require` (encrypted, unverified) and `disable` (plain) must be chosen.

The role Database signs in as should only be in `pg_monitor`:

```sql
CREATE ROLE openasy_monitor LOGIN PASSWORD '<a long random password>' IN ROLE pg_monitor;
-- postgresql.conf: shared_preload_libraries = 'pg_stat_statements', then restart, and in the database it connects to:
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- Only for Explain, which needs to read the tables it plans, for the schemas you want:
GRANT SELECT ON ALL TABLES IN SCHEMA public TO openasy_monitor;
```

Connect to PostgreSQL directly, not through PgBouncer: a pooler shows its own sessions, not the server's. The
instance warns when its role is a superuser, is not in `pg_monitor`, or cannot read `pg_stat_statements`.

## Run

```bash
openssl rand -hex 32 > openasy-kek
docker compose up -d
docker compose logs database | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013). The UI and API
are on http://localhost:8080, the API reference at http://localhost:8080/api/docs/. Add instances under Instances.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DATABASE_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy |
| `DATABASE_SAMPLE_SECONDS` | `60` | How often each instance is sampled, 10 to 3600 |
| `DATABASE_RETENTION_DAYS` | `7` | Samples older than this are deleted, 1 to 90 |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `DATABASE_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key; without it no instance can be added |
| `DATABASE_DB` | `/data/database.db` | SQLite file (WAL), on the `/data` volume |
| `DATABASE_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `DATABASE_HEADLESS` | `false` | `true` serves only the API |
| `DATABASE_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

`/metrics` has each instance's last sample with an `instance` label: `openasy_database_up`,
`openasy_database_connections`, `openasy_database_connections_max`, `openasy_database_sessions_blocked`,
`openasy_database_sessions_idle_in_transaction`, `openasy_database_replication_lag_seconds`,
`openasy_database_transactions_per_second`, `openasy_database_cache_hit_ratio` and `openasy_database_size_bytes`. Keep
them in Metrics and fire on them in Alerts.

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`.

## Roles

Viewers see everything, sessions' statements included; editors also check instances and explain statements; admins
also add, change and delete instances, and manage members and API tokens (ADR 0003). Adding, changing and deleting an
instance is written to the log as an audit event (ADR 0013).

## Not yet

MySQL and MariaDB (performance schema) are not read yet; this release is PostgreSQL 14 or newer. `EXPLAIN ANALYZE`,
suggested indexes, table sizes and bloat, deadlock counts and percentiles of query time are not built. Links from a
slow span in Traces to its query are planned.

## Develop

```bash
npm install
npm test        # plans, blocking chains, sampling, sealed passwords, roles, and every API response against openapi.json
DATABASE_TEST_POSTGRES=postgres://postgres:pw@127.0.0.1:5432/postgres npm test   # and the engine against a real PostgreSQL
npm run dev     # the UI, with the API on :8080
```

The engine tests need a PostgreSQL started with `-c shared_preload_libraries=pg_stat_statements`, as CI starts one of
the oldest supported version and one of the newest.

## Licence

AGPL-3.0 (ADR 0008).
