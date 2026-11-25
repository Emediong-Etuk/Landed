import { describe, expect, it } from "vitest";
import { needleAngle, segments, selectWinner, fmtD } from "@landed/sdk";

describe("PotRing reveal math", () => {
  it("the needle is reproducible from randomness + entries and lands in the winner segment", () => {
    const amounts = [1_000_000n, 5_000_000n, 25_000_000n, 10_000_000n];
    for (let k = 0; k < 200; k++) {
      const rnd = new Uint8Array(32).map((_, i) => (i * 31 + k * 17) & 0xff);
      const w = selectWinner(rnd, amounts)!;
      const a = needleAngle(rnd, amounts)!;
      expect(needleAngle(rnd, amounts)).toBe(a);
      const s = segments(amounts)[w];
      expect(a).toBeGreaterThanOrEqual(s.start);
      expect(a).toBeLessThanOrEqual(s.end);
    }
  });
  it("formats dUSDC with 6 decimals", () => {
    expect(fmtD(12_345_678n)).toBe("12.35");
    expect(fmtD(0n)).toBe("0.00");
  });
});
