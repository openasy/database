// Who blocks whom: the sessions that wait on a lock, under the session holding it, so that each chain names the
// session at its head (ADR 0062). That is the one to look at: its transaction, often idle and forgotten, holds the rest.
import type { Session } from "./engine.ts";

export interface LockNode extends Session {
  /** The sessions waiting on this one, and on those. */
  waiters: LockNode[];
  /** How many sessions wait behind this one, at any depth. */
  blocking: number;
}

export interface Chains {
  /** The heads, with the most sessions behind them first. */
  chains: LockNode[];
  /** Sessions waiting on a lock. */
  waiting: number;
  /** The longest any of them has waited, in seconds. */
  longestWaitSeconds: number | null;
}

/**
 * Puts each waiting session under the first session it waits for. A session that waits on nobody heads its chain; in
 * a cycle, which PostgreSQL ends as a deadlock within a second, the session with the oldest transaction is the head.
 */
export function blockingChains(list: Session[]): Chains {
  const byPid = new Map(list.map((s) => [s.pid, s]));
  // A blocker that is not in the list, such as a session the role may not see, still heads its chain.
  for (const p of list.flatMap((s) => s.blockedBy)) {
    if (!byPid.has(p))
      byPid.set(p, {
        pid: p,
        database: null,
        user: null,
        application: "",
        backendType: null,
        client: null,
        state: null,
        waitEvent: null,
        xactSeconds: null,
        stateSeconds: null,
        query: "",
        blockedBy: [],
        waitingFor: null,
      });
  }
  const sessions = [...byPid.values()];
  const parent = new Map<number, number>();
  for (const s of sessions) {
    const blocker = s.blockedBy.find((p) => byPid.has(p) && p !== s.pid);
    if (blocker !== undefined) parent.set(s.pid, blocker);
  }
  const children = new Map<number, number[]>();
  for (const [child, p] of parent) children.set(p, [...(children.get(p) ?? []), child]);

  const placed = new Set<number>();
  const node = (pid: number): LockNode => {
    placed.add(pid);
    const waiters = (children.get(pid) ?? []).filter((c) => !placed.has(c)).map(node);
    return { ...byPid.get(pid)!, waiters, blocking: waiters.reduce((n, w) => n + 1 + w.blocking, 0) };
  };

  const heads = sessions.filter((s) => children.has(s.pid) && !parent.has(s.pid)).map((s) => node(s.pid));
  // What is left waits in a cycle: start each cycle at its oldest transaction.
  for (;;) {
    const left = sessions.filter((s) => parent.has(s.pid) && !placed.has(s.pid));
    if (!left.length) break;
    const oldest = left.reduce((a, b) => ((b.xactSeconds ?? 0) > (a.xactSeconds ?? 0) ? b : a));
    heads.push(node(oldest.pid));
  }

  const waits = sessions.filter((s) => parent.has(s.pid)).map((s) => s.stateSeconds ?? 0);
  return {
    chains: heads.sort((a, b) => b.blocking - a.blocking || (b.xactSeconds ?? 0) - (a.xactSeconds ?? 0)),
    waiting: parent.size,
    longestWaitSeconds: waits.length ? Math.max(...waits) : null,
  };
}
