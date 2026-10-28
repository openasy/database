// What Database reads from a database server, whatever the engine. PostgreSQL is the one engine of this release
// (postgres.ts); tests give the monitor a fake one.

export type Tls = "verify" | "require" | "disable";

/** Where an instance is and how to sign in to it. The password is opened from its seal only to connect. */
export interface Target {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  tls: Tls;
  /** A PEM certificate authority to verify the server with, when it is not one the system trusts. */
  ca: string | null;
}

export interface Check {
  /** Such as "PostgreSQL 18.6". */
  version: string;
  /** server_version_num: 180006. */
  versionNum: number;
  role: "primary" | "replica";
  superuser: boolean;
  /** In pg_monitor: sees every session's query and every statement. */
  monitor: boolean;
  /** pg_stat_statements can be read in the database Database connects to. */
  statements: boolean;
  /** The databases of the instance people can connect to, for Explain. */
  databases: string[];
  warnings: string[];
}

/** One statement's counters since the statistics were last reset, summed over the users that ran it. */
export interface StatementCounter {
  database: string;
  /** The normalized text: constants are $1, $2. */
  query: string;
  calls: number;
  totalMs: number;
  rows: number;
}

export interface Stats {
  role: "primary" | "replica";
  connections: { total: number; active: number; idle: number; idleInTransaction: number; blocked: number };
  maxConnections: number;
  /** Counters since the statistics were reset; the monitor takes rates from two samples. */
  xactTotal: number;
  blocksHit: number;
  blocksRead: number;
  sizeBytes: number;
  /** A replica: how far behind its primary. A primary: its furthest standby's replay lag. Null when neither. */
  lagSeconds: number | null;
  /** Active sessions by what they wait on, "CPU" for none. */
  waitEvents: Record<string, number>;
  /** Null when pg_stat_statements cannot be read. */
  statements: StatementCounter[] | null;
}

export interface Session {
  pid: number;
  database: string | null;
  user: string | null;
  application: string;
  /** "client backend" for a connection; autovacuum and other workers can hold locks too. */
  backendType: string | null;
  client: string | null;
  state: string | null;
  waitEvent: string | null;
  /** How long its transaction has been open; null outside one. */
  xactSeconds: number | null;
  /** How long it has been in its state. */
  stateSeconds: number | null;
  query: string;
  /** The sessions holding a lock it waits for. */
  blockedBy: number[];
  /** The lock it waits for, such as "AccessShareLock on payments". */
  waitingFor: string | null;
}

export interface Standby {
  name: string;
  client: string | null;
  state: string | null;
  syncState: string | null;
  writeLagSeconds: number | null;
  flushLagSeconds: number | null;
  replayLagSeconds: number | null;
  /** WAL the standby has not replayed yet. */
  behindBytes: number | null;
}

export interface Slot {
  name: string;
  type: string;
  database: string | null;
  active: boolean;
  /** WAL the server keeps for the slot until it advances. */
  retainedBytes: number | null;
}

export interface Replication {
  role: "primary" | "replica";
  lagSeconds: number | null;
  standbys: Standby[];
  slots: Slot[];
}

export interface Explained {
  /** The plan as EXPLAIN (FORMAT JSON) gives it. */
  plan: unknown;
  /** Placeholders such as $1 the statement has; its plan is the generic one, whatever their values. */
  parameters: number;
}

/** Why an engine call failed: the server could not be reached or signed in to, or it refused the statement. */
export class EngineError extends Error {
  readonly kind: "unreachable" | "refused";
  constructor(kind: "unreachable" | "refused", message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface Engine {
  check(): Promise<Check>;
  stats(): Promise<Stats>;
  sessions(): Promise<Session[]>;
  replication(): Promise<Replication>;
  /** EXPLAIN in a read-only transaction, never ANALYZE: the statement is planned, not run. */
  explain(sql: string, database: string): Promise<Explained>;
  close(): Promise<void>;
}

export type Connect = (target: Target) => Engine;
