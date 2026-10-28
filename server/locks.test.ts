import { describe, expect, it } from "vitest";
import { blockingChains } from "./locks.ts";
import { session } from "./test-app.ts";

describe("blockingChains", () => {
  it("names the session at the head of each chain, with everyone waiting behind it", () => {
    // The story's migration: 48211 sits idle in a transaction; three wait on it, and one waits on one of those.
    const { chains, waiting, longestWaitSeconds } = blockingChains([
      session(48211, { state: "idle in transaction", xactSeconds: 252 }),
      session(48302, { blockedBy: [48211], stateSeconds: 230, waitingFor: "ShareLock on transaction 99812773" }),
      session(48315, { blockedBy: [48211], stateSeconds: 221 }),
      session(48399, { blockedBy: [48211], stateSeconds: 122 }),
      session(48410, { blockedBy: [48399], stateSeconds: 118 }),
      session(50117, { xactSeconds: 12 }),
      session(50120, { blockedBy: [50117], stateSeconds: 11 }),
      session(1, {}),
    ]);
    expect(chains.map((c) => [c.pid, c.blocking])).toEqual([
      [48211, 4],
      [50117, 1],
    ]);
    expect(chains[0]!.waiters.map((w) => w.pid)).toEqual([48302, 48315, 48399]);
    expect(chains[0]!.waiters[2]!.waiters[0]!.pid).toBe(48410);
    expect(chains[0]!.waiters[0]!.waitingFor).toBe("ShareLock on transaction 99812773");
    expect(waiting).toBe(5);
    expect(longestWaitSeconds).toBe(230);
  });

  it("is empty when nobody waits", () => {
    expect(blockingChains([session(1), session(2)])).toEqual({ chains: [], waiting: 0, longestWaitSeconds: null });
  });

  it("starts a cycle at its oldest transaction, and shows each session once", () => {
    const { chains } = blockingChains([
      session(1, { blockedBy: [2], xactSeconds: 5 }),
      session(2, { blockedBy: [1], xactSeconds: 9 }),
      session(3, { blockedBy: [2, 1] }),
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.pid).toBe(2);
    expect(chains[0]!.blocking).toBe(2);
  });

  it("keeps a blocker it cannot see at the head, with nothing known but its pid", () => {
    const { chains, waiting } = blockingChains([session(7, { blockedBy: [999] })]);
    expect(chains.map((c) => [c.pid, c.query, c.blocking])).toEqual([[999, "", 1]]);
    expect(waiting).toBe(1);
  });
});
