import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { entriesHash, hex, selectWinner, type Ledger, type PendingWithdrawal, type Table } from "@landed/sdk";
import { runAll, type Snapshot } from "../src/checks";

const D = 1_000_000n;
const now = 1_764_000_000_000;
const pk = () => Keypair.generate().publicKey;
const A = pk(), B = pk(), T = pk();

const emptyRing = (): PendingWithdrawal[] => Array.from({ length: 16 }, () => ({ nonce: 0n, amount: 0n, requestedTs: 0n, state: 0, fault: 0 }));
function ledger(owner: PublicKey, o: Partial<Ledger>): Ledger {
  return {
    owner, available: 0n, ingestedCount: 0n, ingestedTotal: 0n, withdrawNonce: 0n, withdrawRequestedTotal: 0n, creditedTotal: 0n, debitedTotal: 0n,
    ring: emptyRing(), session: { signer: PublicKey.default, expiresTs: 0n, cap: 0n, spent: 0n }, stats: { rounds: 0n, wins: 0n, wagered: 0n, won: 0n }, ...o,
  };
}

/** A consistent world: A & B deposited 50 each, played one round (A 10, B 10, B won), A withdrew 5 (paid). */
function clean(): Snapshot {
  const rnd = new Uint8Array(32).fill(3);
  const amounts = [10n * D, 10n * D];
  const players = [A, B];
  const w = selectWinner(rnd, amounts)!;
  const pot = 20n * D, fee = 400_000n, credit = pot - fee;
  const winner = players[w], loser = players[1 - w];
  const eh = entriesHash(players.map((p) => p.toBytes()), amounts);
  const ringA = emptyRing();
  ringA[0] = { nonce: 0n, amount: 5n * D, requestedTs: BigInt(now / 1000 - 30), state: 2, fault: 1 };
  const la = (who: PublicKey, isWinner: boolean, withdrew: boolean) =>
    ledger(who, {
      available: 50n * D - 10n * D + (isWinner ? credit : 0n) - (withdrew ? 5n * D : 0n),
      ingestedCount: 1n, ingestedTotal: 50n * D,
      withdrawNonce: withdrew ? 1n : 0n, withdrawRequestedTotal: withdrew ? 5n * D : 0n, ring: withdrew ? ringA : emptyRing(),
    });
  const ledgersEr = new Map<string, Ledger>([
    [winner.toBase58(), la(winner, true, winner.equals(A))],
    [loser.toBase58(), la(loser, false, loser.equals(A))],
    [T.toBase58(), ledger(T, { available: fee })],
  ]);
  const hist: Table["history"] = Array.from({ length: 16 }, () => ({ roundId: 0n, pot: 0n, fee: 0n, vrfNonce: 0n, settledTs: 0n, winner: PublicKey.default, randomness: new Uint8Array(32), entriesHash: new Uint8Array(32), outcome: 0, winnerIdx: 0, entryCount: 0, closedBy: 0 }));
  hist[0] = { roundId: 1n, pot, fee, vrfNonce: 1n, settledTs: 1n, winner, randomness: rnd, entriesHash: eh, outcome: 1, winnerIdx: w, entryCount: 2, closedBy: 2 };
  const table = { roundId: 2n, pot: 0n, status: 0, history: hist, historyLen: 1n, staleCallbacks: 0n, vrfRetries: 0n, roundsVoided: 0n, closesByCrank: 1n, closesByKeeper: 0n } as unknown as Table;
  return {
    label: "fixture", fetchedAtMs: now, houseFeeBps: 200,
    vaultAmount: 100n * D - 5n * D,
    deposits: [A, B].map((o) => ({ owner: o, nonce: 0n, amount: 50n * D, ts: 0n, slot: 0n })),
    withdrawals: [{ owner: A, nonce: 0n, amount: 5n * D, destAta: pk(), path: 1, rescuer: B, ts: 0n, slot: 0n }],
    owners: [A, B, T].map((x) => x.toBase58()),
    ledgersEr, ledgersL1: new Map(), erSnapshotSlot: 1, table, tableL1: null,
    rounds: [{
      roundId: 1n, entries: players.map((p, i) => ({ player: p.toBase58(), amount: amounts[i] })), closedEntriesHash: hex(eh),
      drawn: { randomness: hex(rnd), vrfNonce: 1n, winnerIdx: w, sig: "s", viaVrfProgram: true },
      settled: { winner: winner.toBase58(), pot, fee, credit, sig: "s2" }, staleIgnored: 0, retries: 0,
    }],
    notes: [],
  };
}
const failing = (s: Snapshot) => runAll(s).filter((c) => c.status === "fail");
const byId = (s: Snapshot, id: string) => runAll(s).find((c) => c.id === id)!;

describe("verifier on a consistent world", () => {
  it("passes every invariant", () => {
    const f = failing(clean());
    expect(f, JSON.stringify(f, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toEqual([]);
    expect(byId(clean(), "I6").status).toBe("pass");
  });
});

describe("tampered datasets are flagged with precise messages", () => {
  it("phantom receipt (nonce never requested)", () => {
    const s = clean();
    s.withdrawals.push({ owner: B, nonce: 7n, amount: 1n * D, destAta: pk(), path: 1, rescuer: A, ts: 0n, slot: 0n });
    s.vaultAmount -= 1n * D;
    expect(byId(s, "I5").status).toBe("fail");
    expect(byId(s, "I5").detail).toMatch(/phantom receipt/);
  });
  it("orphaned vault surplus (stranded funds)", () => {
    const s = clean();
    s.vaultAmount += 10n * D;
    expect(byId(s, "I1").status).toBe("fail");
    expect(byId(s, "I1").detail).toMatch(/orphaned vault surplus/);
  });
  it("wrong winner", () => {
    const s = clean();
    const r = s.rounds[0];
    const other = r.entries.find((e) => e.player !== r.settled!.winner)!.player;
    r.settled!.winner = other;
    expect(byId(s, "I6").status).toBe("fail");
    expect(byId(s, "I6").detail).toMatch(/winner/);
  });
  it("fee off by one", () => {
    const s = clean();
    s.rounds[0].settled!.fee += 1n;
    s.table!.history[0].fee += 1n;
    expect(byId(s, "I6").status).toBe("fail");
    expect(byId(s, "I6").detail).toMatch(/fee/);
  });
  it("duplicate receipt", () => {
    const s = clean();
    s.withdrawals.push({ ...s.withdrawals[0] });
    expect(byId(s, "I5").detail).toMatch(/duplicate receipt/);
  });
  it("stale-nonce settle: randomness not from the VRF program / not the locked entries", () => {
    const s = clean();
    s.rounds[0].drawn!.viaVrfProgram = false;
    expect(byId(s, "I6").detail).toMatch(/VRF-program/);
    const s2 = clean();
    s2.rounds[0].entries[0].amount += 1n;
    expect(byId(s2, "I6").detail).toMatch(/entries hash/);
  });
  it("owed > 60 s", () => {
    const s = clean();
    const l = s.ledgersEr.get(B.toBase58())!;
    l.ring[0] = { nonce: 0n, amount: 2n * D, requestedTs: BigInt(now / 1000 - 120), state: 1, fault: 1 };
    l.withdrawNonce = 1n; l.withdrawRequestedTotal = 2n * D; l.available -= 2n * D;
    const c = byId(s, "I3");
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/older than 60 s/);
  });
  it("rollup zero-sum broken (I2)", () => {
    const s = clean();
    s.ledgersEr.get(A.toBase58())!.available += 1n;
    expect(byId(s, "I2").status).toBe("fail");
  });
  it("naive baseline: stranded funds are reported", () => {
    const s = clean();
    s.naive = { vaultAmount: 30n * D, ledgers: [{ owner: A, balance: 10n * D, fundedTotal: 50n * D, requestedTotal: 40n * D, cashoutCount: 4n }] };
    const n = byId(s, "N1");
    expect(n.status).toBe("fail");
    expect(n.detail).toMatch(/20\.000000 dUSDC STRANDED/);
  });
});
