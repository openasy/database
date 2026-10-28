import { describe, expect, it } from "vitest";
import { sealer } from "./seal.ts";

describe("sealer", () => {
  const key = Buffer.alloc(32, 1);

  it("seals so that only the same key opens it", () => {
    const sealed = sealer(key).seal("monitor password");
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toContain("monitor");
    expect(sealer(key).open(sealed)).toBe("monitor password");
    expect(() => sealer(Buffer.alloc(32, 2)).open(sealed)).toThrow();
    expect(() => sealer(undefined).open(sealed)).toThrow(/secrets key/);
  });

  it("never keeps a password in the clear: without a key it does not seal", () => {
    expect(sealer(undefined).ready).toBe(false);
    expect(() => sealer(undefined).seal("plain")).toThrow(/No secrets key/);
    expect(() => sealer(key).open("plain")).toThrow(/not sealed/);
  });
});
