/**
 * Pure invariant checks over a chain Snapshot. No network, no trust in our
 * backend: every input comes straight from L1 / ER account data and ER tx logs.
 */
import { PublicKey } from "@solana/web3.js";
import {
  entriesHash,
  fromHex,
  hex,
  houseFee,
  OWED_ALERT_SECS,
  ROUND_OUTCOME,
  selectWinner,
  SLOT_STATE,
  type DepositReceipt,
  type Ledger,
  type NLedger,
  type Table,
  type WithdrawReceipt,
} from "@landed/sdk";

export interface RoundRecon {
  roundId: bigint;
  entries: { player: string; amount: bigint }[];
  closedEntriesHash?: string;
  closedBy?: number;
  drawn?: { randomness: string; vrfNonce: bigint; winnerIdx: number; sig: string; viaVrfProgram: boolean };
  settled?: { winner: string; pot: bigint; fee: bigint; credit: bigint; sig: string };
  voided?: { refunded: bigint; sig: string };
  staleIgnored: number;
  retries: number;
}

export interface Snapshot {
  label: string;
  fetchedAtMs: number;
  houseFeeBps: number;
  vaultAmount: bigint;
  deposits: DepositReceipt[];
  withdrawals: WithdrawReceipt[];
  owners: string[];
  ledgersEr: Map<string, Ledger>;
  ledgersL1: Map<string, Ledger>;
  erSnapshotSlot: number | null;
  table: Table | null;
  tableL1: Table | null;
  rounds: RoundRecon[];
  naive?: { vaultAmount: bigint; ledgers: NLedger[]; paidTotal?: bigint };
  notes: string[];
}

export type Status = "pass" | "fail" | "warn" | "skip";
export interface CheckResult { id: string; title: string; status: Status; detail: string; data?: unknown }

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const d = (x: bigint) => `${(Number(x) / 1e6).toFixed(6)} dUSDC`;

export function checkI1(s: Snapshot): CheckResult {
  const dep = sum(s.deposits.map((r) => r.amount));
  const wdr = sum(s.withdrawals.map((r) => r.amount));
  const expected = dep - wdr;
  const ok = s.vaultAmount === expected;
  return {
    id: "I1", title: "Vault == Σ deposits − Σ withdraw receipts (L1, exact)", status: ok ? "pass" : "fail",
    detail: ok ? `vault ${d(s.vaultAmount)} = ${s.deposits.length} deposits ${d(dep)} − ${s.withdrawals.length} receipts ${d(wdr)}`
      : `vault ${d(s.vaultAmount)} ≠ expected ${d(expected)} (diff ${d(s.vaultAmount - expected)}: ${s.vaultAmount > expected ? "orphaned vault surplus" : "vault deficit"})`,
    data: { vault: s.vaultAmount, deposits: dep, receipts: wdr },
  };
}

export function checkI2(s: Snapshot): CheckResult {
  if (!s.ledgersEr.size) return { id: "I2", title: "Rollup zero-sum (one ER snapshot)", status: "skip", detail: "no ER ledgers readable" };
  const ls = [...s.ledgersEr.values()];
  const avail = sum(ls.map((l) => l.available));
  const pot = s.table?.status === 0 || s.table?.status === 1 || s.table?.status === 2 ? s.table.pot : 0n;
  const ing = sum(ls.map((l) => l.ingestedTotal));
  const req = sum(ls.map((l) => l.withdrawRequestedTotal));
  const ok = avail + pot === ing - req;
  return {
    id: "I2", title: "Rollup zero-sum: Σ available + open pot == Σ ingested − Σ requested", status: ok ? "pass" : "fail",
    detail: `${ls.length} ledgers @ ER slot ${s.erSnapshotSlot ?? "?"}: available ${d(avail)} + pot ${d(pot)} ${ok ? "=" : "≠"} ingested ${d(ing)} − requested ${d(req)}`,
  };
}

export interface Owed { owner: string; nonce: bigint; amount: bigint; ageSecs: number }
export function owedItems(s: Snapshot): Owed[] {
  const paid = new Set(s.withdrawals.map((r) => `${r.owner.toBase58()}:${r.nonce}`));
  const out: Owed[] = [];
  for (const [owner, l] of s.ledgersEr) {
    for (const e of l.ring) {
      if (e.state !== SLOT_STATE.PENDING) continue;
      if (paid.has(`${owner}:${e.nonce}`)) continue;
      out.push({ owner, nonce: e.nonce, amount: e.amount, ageSecs: Math.max(0, Math.floor(s.fetchedAtMs / 1000 - Number(e.requestedTs))) });
    }
  }
  return out;
}

export function checkI3(s: Snapshot): CheckResult {
  const owed = owedItems(s);
  const perOwnerNeg: string[] = [];
  for (const [owner, l] of s.ledgersEr) {
    const rec = sum(s.withdrawals.filter((r) => r.owner.toBase58() === owner).map((r) => r.amount));
    if (l.withdrawRequestedTotal < rec) perOwnerNeg.push(owner);
  }
  const old = owed.filter((o) => o.ageSecs > OWED_ALERT_SECS);
  const status: Status = perOwnerNeg.length || old.length ? "fail" : "pass";
  return {
    id: "I3", title: `Owed ≥ 0 and nothing owed for more than ${OWED_ALERT_SECS} s`, status,
    detail: perOwnerNeg.length ? `receipts exceed requests for ${perOwnerNeg.join(", ")}`
      : `${owed.length} in flight (${d(sum(owed.map((o) => o.amount)))}), ${old.length} older than ${OWED_ALERT_SECS} s` +
        (old.length ? `: ${old.map((o) => `${o.owner.slice(0, 6)}#${o.nonce} (${o.ageSecs}s)`).join(", ")}` : ""),
    data: owed,
  };
}

export function checkI4(s: Snapshot): CheckResult {
  const ing = sum([...s.ledgersEr.values()].map((l) => l.ingestedTotal));
  const rec = sum(s.withdrawals.map((r) => r.amount));
  const ok = s.vaultAmount >= ing - rec;
  return { id: "I4", title: "Solvency: vault ≥ Σ ingested − Σ receipts", status: ok ? "pass" : "fail", detail: `vault ${d(s.vaultAmount)} vs liabilities ${d(ing - rec)}` };
}

export function checkI5(s: Snapshot): CheckResult {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of s.withdrawals) {
    const o = r.owner.toBase58();
    const key = `${o}:${r.nonce}`;
    if (seen.has(key)) problems.push(`duplicate receipt ${key}`);
    seen.add(key);
    const l = s.ledgersEr.get(o) ?? s.ledgersL1.get(o);
    if (!l) { problems.push(`receipt ${key} has no ledger`); continue; }
    if (r.nonce >= l.withdrawNonce) problems.push(`phantom receipt ${key}: nonce ≥ ledger withdraw_nonce ${l.withdrawNonce}`);
    for (const led of [s.ledgersEr.get(o), s.ledgersL1.get(o)]) {
      const slot = led?.ring.find((e) => e.nonce === r.nonce && e.state !== SLOT_STATE.EMPTY);
      if (slot && slot.amount !== r.amount) problems.push(`receipt ${key} amount ${r.amount} ≠ committed request ${slot.amount}`);
    }
  }
  for (const [o, l] of s.ledgersEr) {
    const rec = sum(s.withdrawals.filter((r) => r.owner.toBase58() === o).map((r) => r.amount));
    if (rec > l.withdrawRequestedTotal) problems.push(`${o}: receipts ${rec} > requested ${l.withdrawRequestedTotal}`);
  }
  return {
    id: "I5", title: "No phantom payouts: every receipt matches a committed request", status: problems.length ? "fail" : "pass",
    detail: problems.length ? problems.slice(0, 6).join("; ") : `${s.withdrawals.length} receipts, all matched`,
  };
}

export function checkI6(s: Snapshot): CheckResult {
  const t = s.table;
  const problems: string[] = [];
  let verified = 0, partial = 0;
  const historyById = new Map<string, Table["history"][number]>();
  if (t) for (const h of t.history) if (h.roundId > 0n) historyById.set(h.roundId.toString(), h);
  // Fee rule on every history entry we can see.
  for (const h of historyById.values()) {
    if (h.outcome === ROUND_OUTCOME.SETTLED && h.fee !== houseFee(h.pot, s.houseFeeBps)) problems.push(`round ${h.roundId}: fee ${h.fee} ≠ floor(pot·bps)`);
  }
  for (const r of s.rounds) {
    if (!r.settled) continue;
    const h = historyById.get(r.roundId.toString());
    if (!r.drawn) { partial++; continue; }
    const amounts = r.entries.map((e) => e.amount);
    const players = r.entries.map((e) => e.player);
    if (!amounts.length) { partial++; continue; }
    const eh = hex(entriesHash(players.map((p) => new PublicKey(p).toBytes()), amounts));
    if (r.closedEntriesHash && eh !== r.closedEntriesHash) problems.push(`round ${r.roundId}: reconstructed entries hash ≠ hash locked at close`);
    if (h && hex(h.entriesHash) !== eh) problems.push(`round ${r.roundId}: entries hash ≠ on-chain history`);
    const w = selectWinner(fromHex(r.drawn.randomness), amounts);
    if (w === null || players[w] !== r.settled.winner) problems.push(`round ${r.roundId}: winner ${r.settled.winner.slice(0, 6)} ≠ select_winner → ${w === null ? "none" : players[w].slice(0, 6)}`);
    const pot = amounts.reduce((a, b) => a + b, 0n);
    if (r.settled.pot !== pot) problems.push(`round ${r.roundId}: pot ${r.settled.pot} ≠ Σ entries ${pot}`);
    if (r.settled.fee !== houseFee(pot, s.houseFeeBps)) problems.push(`round ${r.roundId}: fee off (${r.settled.fee} vs ${houseFee(pot, s.houseFeeBps)})`);
    if (r.settled.credit !== pot - r.settled.fee) problems.push(`round ${r.roundId}: credit ≠ pot − fee`);
    if (!r.drawn.viaVrfProgram) problems.push(`round ${r.roundId}: randomness not delivered by a VRF-program transaction`);
    if (h && hex(h.randomness) !== r.drawn.randomness) problems.push(`round ${r.roundId}: randomness ≠ history`);
    verified++;
  }
  const status: Status = problems.length ? "fail" : verified ? "pass" : historyById.size ? "warn" : "skip";
  return {
    id: "I6", title: "Fair rounds: winner = select_winner(VRF randomness, locked entries); fee exact", status,
    detail: problems.length ? problems.slice(0, 6).join("; ")
      : `${verified} rounds fully recomputed from events, ${historyById.size} on-chain history entries fee-checked${partial ? `, ${partial} without retrievable entries` : ""}`,
  };
}

export function fChecks(s: Snapshot): CheckResult[] {
  const out: CheckResult[] = [];
  const t = s.table;
  if (t) {
    const closes = Number(t.closesByCrank + t.closesByKeeper);
    out.push({
      id: "F3", title: "Stale VRF callbacks ignored / voided rounds refunded", status: "pass",
      detail: `${t.staleCallbacks} stale callbacks ignored (no state change), ${t.vrfRetries} retries, ${t.roundsVoided} voided rounds`,
    });
    const voidBad = s.rounds.filter((r) => r.voided && r.voided.refunded !== sum(r.entries.map((e) => e.amount)) && r.entries.length);
    if (voidBad.length) out[out.length - 1] = { ...out[out.length - 1], status: "fail", detail: `voided rounds not fully refunded: ${voidBad.map((r) => r.roundId).join(",")}` };
    out.push({
      id: "F4", title: "Crank coverage (rounds closed by the crank vs the watchdog)", status: closes ? "pass" : "skip",
      detail: closes ? `${t.closesByCrank} by crank, ${t.closesByKeeper} by watchdog (${((Number(t.closesByCrank) / closes) * 100).toFixed(1)}% crank)` : "no closes yet",
      data: { crank: t.closesByCrank, watchdog: t.closesByKeeper },
    });
    if (s.tableL1) {
      const lag = t.historyLen - s.tableL1.historyLen;
      out.push({ id: "F7", title: "Two truths: L1 copy of the table trails the ER by ≤ 1 commit", status: lag <= 1n ? "pass" : "warn", detail: `ER history ${t.historyLen}, committed on L1 ${s.tableL1.historyLen}` });
    }
  }
  return out;
}

/** Baseline check: the naive vault should equal what its ledgers still owe. Any surplus = stranded funds. */
export function checkNaive(s: Snapshot): CheckResult | null {
  if (!s.naive) return null;
  const owed = sum(s.naive.ledgers.map((l) => l.balance));
  const stranded = s.naive.vaultAmount - owed;
  const debited = sum(s.naive.ledgers.map((l) => l.requestedTotal));
  return {
    id: "N1", title: "Naive baseline: vault == Σ ledger balances (no stranded funds)", status: stranded === 0n ? "pass" : "fail",
    detail: stranded === 0n ? `no stranded funds across ${s.naive.ledgers.length} ledgers`
      : `${d(stranded)} STRANDED: debited in the rollup (${d(debited)} total cash-outs requested) but never paid; no rescue path exists`,
    data: { stranded, vault: s.naive.vaultAmount, owed },
  };
}

export function runAll(s: Snapshot): CheckResult[] {
  const r = [checkI1(s), checkI2(s), checkI3(s), checkI4(s), checkI5(s), checkI6(s), ...fChecks(s)];
  const n = checkNaive(s);
  if (n) r.push(n);
  return r;
}

