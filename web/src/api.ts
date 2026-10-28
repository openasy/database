// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export type Tls = "verify" | "require" | "disable";
export type Role = "primary" | "replica";

/** Another OpenAsy product of this install, from OPENASY_PRODUCTS. */
export interface ProductLink {
  id: string;
  url: string;
}

export interface InstanceStatus {
  checkedAt: string;
  ok: boolean;
  error: string | null;
  version: string | null;
  role: Role | null;
  databases: string[];
  warnings: string[];
}

/** A database server. Its password is never sent back. */
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
  role: Role;
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
  role: Role | null;
  ok: boolean | null;
  error: string | null;
  warnings: string[];
  latest: Sample | null;
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
  share: number;
}

export interface Point {
  at: string;
  calls: number;
  meanMs: number | null;
}

export interface QueryList {
  from: string;
  totalMs: number;
  statements: number;
  databases: Array<{ database: string; count: number }>;
  queries: QueryStat[];
  points: Point[];
}

export interface QueryDetail {
  key: string;
  database: string;
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
  points: Point[];
}

export interface Session {
  pid: number;
  database: string | null;
  user: string | null;
  application: string;
  backendType: string | null;
  client: string | null;
  state: string | null;
  waitEvent: string | null;
  xactSeconds: number | null;
  stateSeconds: number | null;
  query: string;
  blockedBy: number[];
  waitingFor: string | null;
}

export interface LockNode extends Session {
  waiters: LockNode[];
  blocking: number;
}

export interface Locks {
  chains: LockNode[];
  waiting: number;
  longestWaitSeconds: number | null;
}

export interface Connections {
  sessions: Session[];
  maxConnections: number | null;
  byApplication: Array<{ application: string; count: number }>;
}

export interface Standby {
  name: string;
  client: string | null;
  state: string | null;
  syncState: string | null;
  writeLagSeconds: number | null;
  flushLagSeconds: number | null;
  replayLagSeconds: number | null;
  behindBytes: number | null;
}

export interface Slot {
  name: string;
  type: string;
  database: string | null;
  active: boolean;
  retainedBytes: number | null;
}

export interface Replication {
  role: Role;
  lagSeconds: number | null;
  standbys: Standby[];
  slots: Slot[];
}

export interface PlanNode {
  op: string;
  detail: string[];
  startupCost: number;
  totalCost: number;
  rows: number;
  selfCost: number;
  share: number;
  hot: boolean;
  children: PlanNode[];
}

export interface Plan {
  database: string;
  parameters: number;
  totalCost: number;
  rows: number;
  root: PlanNode;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
