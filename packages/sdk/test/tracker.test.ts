import { describe, expect, it } from "vitest";
import { newCashout, nextAction, rebuildFromChain, reduceCashout, newDeposit, reduceDeposit } from "../src/tracker";
import { RESCUE_AFTER_MS } from "../src/constants";

const t0 = 1_000_000;
describe("SettlementTracker — cash-out", () => {
  it("happy path: requested → committed → paid(action) → acked", () => {
    let s = newCashout("o", 0n, 10n, t0, false, "erSig");
    expect(nextAction(s, t0 + 100)).toBe("wait");
    s = reduceCashout(s, { type: "commit_seen", at: t0 + 300, pending: true });
    expect(s.step).toBe("committed");
    s = reduceCashout(s, { type: "receipt_seen", at: t0 + 900, path: 0, sig: "l1" });
    expect(s.step).toBe("paid");
    expect(s.path).toBe("action");
    expect(nextAction(s, t0 + 1000)).toBe("ack");
    s = reduceCashout(s, { type: "acked", at: t0 + 1200 });
    expect(s.step).toBe("acked");
    expect(nextAction(s, t0 + 2000)).toBe("none");
    expect(s.history.map((h) => h.step)).toEqual(["requested", "committed", "paid", "acked"]);
  });
  it("dropped branch: committed with no receipt → action_dropped → rescue_sent → paid(rescue)", () => {
    let s = reduceCashout(newCashout("o", 3n, 10n, t0, true), { type: "commit_seen", at: t0 + 500, pending: true });
    expect(nextAction(s, t0 + RESCUE_AFTER_MS - 1)).toBe("wait");
    expect(nextAction(s, t0 + RESCUE_AFTER_MS)).toBe("rescue");
    s = reduceCashout(s, { type: "tick", at: t0 + RESCUE_AFTER_MS });
    expect(s.step).toBe("action_dropped");
    s = reduceCashout(s, { type: "rescue_sent", at: t0 + RESCUE_AFTER_MS + 10, sig: "r" });
    expect(s.step).toBe("rescue_sent");
    s = reduceCashout(s, { type: "receipt_seen", at: t0 + RESCUE_AFTER_MS + 800, path: 1 });
    expect(s.step).toBe("paid");
    expect(s.path).toBe("rescue");
    expect(s.history.map((h) => h.step)).toEqual(["requested", "committed", "action_dropped", "rescue_sent", "paid"]);
  });
  it("stuck commit: nothing committed after grace → request_commit, then rescue", () => {
    let s = newCashout("o", 1n, 5n, t0);
    expect(nextAction(s, t0 + RESCUE_AFTER_MS)).toBe("request_commit");
    s = reduceCashout(s, { type: "commit_forced", at: t0 + RESCUE_AFTER_MS });
    expect(s.step).toBe("commit_forced");
    s = reduceCashout(s, { type: "commit_seen", at: t0 + RESCUE_AFTER_MS + 500, pending: true });
    expect(s.step).toBe("committed");
    expect(nextAction(s, t0 + RESCUE_AFTER_MS + 600)).toBe("rescue");
  });
  it("receipt is idempotent and wins any race", () => {
    let s = reduceCashout(newCashout("o", 0n, 1n, t0), { type: "receipt_seen", at: t0 + 1, path: 0 });
    s = reduceCashout(s, { type: "receipt_seen", at: t0 + 2, path: 1 });
    s = reduceCashout(s, { type: "rescue_sent", at: t0 + 3 });
    expect(s.step).toBe("paid");
    expect(s.path).toBe("action");
  });
  it("reload recovery rebuilds every operation from chain state", () => {
    const ring = [
      { nonce: 0n, amount: 10n, requestedTs: 100n, state: 2, fault: 0 },
      { nonce: 1n, amount: 5n, requestedTs: 101n, state: 1, fault: 1 },
      { nonce: 2n, amount: 7n, requestedTs: 102n, state: 1, fault: 0 },
      ...Array.from({ length: 13 }, () => ({ nonce: 0n, amount: 0n, requestedTs: 0n, state: 0, fault: 0 })),
    ];
    const out = rebuildFromChain("o", ring, new Set([1n, 2n]), new Map([[0n, { path: 0 }], [2n, { path: 0 }]]), 200_000);
    expect(out.map((s) => [s.nonce, s.step])).toEqual([[2n, "paid"], [1n, "action_dropped"], [0n, "acked"]]);
    expect(nextAction(out[1], 200_000)).toBe("rescue");
  });
});

describe("SettlementTracker — deposit", () => {
  it("signed → confirmed → credited", () => {
    let d = newDeposit("o", 0n, 50n, t0, "s");
    d = reduceDeposit(d, { type: "receipt_confirmed", at: t0 + 400 });
    d = reduceDeposit(d, { type: "ingested", at: t0 + 900 });
    expect(d.step).toBe("credited");
    expect(d.history.map((h) => h.step)).toEqual(["signed", "confirmed", "credited"]);
  });
});
