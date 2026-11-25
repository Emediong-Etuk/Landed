import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { crankTaskId, entriesHash, fromHex, hex, houseFee, needleAngle, segments, selectWinner, drawTarget, vrfCallerSeed } from "../src/core";

const vectors = JSON.parse(readFileSync(new URL("../../../crates/landed-core/vectors.json", import.meta.url), "utf8"));

describe("golden vectors (Rust landed-core ⇄ TS)", () => {
  it("winner, target, fee, entries hash and VRF seed match for every case", () => {
    expect(vectors.winner_cases.length).toBeGreaterThan(60);
    for (const c of vectors.winner_cases) {
      const amounts = c.amounts.map((a: string) => BigInt(a));
      const rnd = fromHex(c.randomness);
      expect(selectWinner(rnd, amounts)).toBe(c.winner);
      const pot = BigInt(c.pot);
      if (c.target !== null) expect(drawTarget(rnd, pot)!.toString()).toBe(c.target);
      if (c.fee !== null) expect(houseFee(pot, 200)!.toString()).toBe(c.fee);
      const players = amounts.map((_: bigint, k: number) => { const p = new Uint8Array(32); p[0] = k; p[31] = 0xaa; return p; });
      const eh = entriesHash(players, amounts);
      expect(hex(eh)).toBe(c.entries_hash);
      const s = c.caller_seed;
      expect(hex(vrfCallerSeed(BigInt(s.table_id), BigInt(s.round_id), eh, BigInt(s.closes_ts), BigInt(s.vrf_nonce)))).toBe(s.seed);
    }
  });
  it("fee cases", () => {
    for (const f of vectors.fee_cases) expect(houseFee(BigInt(f.pot), f.bps)!.toString()).toBe(f.fee);
  });
  it("crank task id", () => {
    const c = vectors.crank_task_id;
    expect(crankTaskId(fromHex(c.program_id), fromHex(c.table)).toString()).toBe(c.task_id);
  });
});

describe("ring geometry", () => {
  it("needle always lands inside the winner's segment", () => {
    for (const c of vectors.winner_cases.slice(0, 40)) {
      const amounts = c.amounts.map((a: string) => BigInt(a));
      if (amounts.reduce((s: bigint, a: bigint) => s + a, 0n) > (1n << 64n) - 1n) continue;
      const rnd = fromHex(c.randomness);
      const w = selectWinner(rnd, amounts)!;
      const ang = needleAngle(rnd, amounts)!;
      const seg = segments(amounts)[w];
      expect(ang).toBeGreaterThanOrEqual(seg.start);
      expect(ang).toBeLessThanOrEqual(seg.end);
    }
  });
  it("segments cover 360°", () => {
    const s = segments([1n, 2n, 3n]);
    expect(s[0].start).toBe(0);
    expect(s[2].end).toBe(360);
  });
});
