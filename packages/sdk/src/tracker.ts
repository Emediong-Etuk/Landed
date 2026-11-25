/**
 * SettlementTracker — a pure state machine for one deposit or cash-out, fed
 * ONLY by chain observations. The UI's Settlement Rail renders its state; the
 * page and the keeper decide the next permissionless step from `nextAction`.
 *
 * Cash-out:  requested(ER) → committed(L1) → paid(receipt, path=action)
 *            requested → committed → action_dropped → rescue_sent → paid(path=rescue)
 *            requested → (no commit after N s) → commit_forced → committed → …
 * Deposit:   signed → confirmed(L1 receipt) → credited(ER ingest)
 */
import { PAY_PATH, RESCUE_AFTER_MS } from "./constants";

export type CashoutStep = "requested" | "committed" | "action_dropped" | "commit_forced" | "rescue_sent" | "paid" | "acked";
export type DepositStep = "signed" | "confirmed" | "credited";

export interface StepRecord { step: string; at: number; sig?: string; layer?: "L1" | "ER" }

export interface CashoutState {
  kind: "cashout";
  owner: string;
  nonce: bigint;
  amount: bigint;
  step: CashoutStep;
  path?: "action" | "rescue";
  requestedAt: number;
  history: StepRecord[];
  fault: boolean;
}
export interface DepositState {
  kind: "deposit";
  owner: string;
  nonce: bigint;
  amount: bigint;
  step: DepositStep;
  signedAt: number;
  history: StepRecord[];
}

export type Observation =
  | { type: "withdraw_requested"; at: number; sig?: string }
  | { type: "commit_seen"; at: number; pending: boolean } // committed L1 ledger shows this nonce Pending
  | { type: "receipt_seen"; at: number; path: number; sig?: string }
  | { type: "rescue_sent"; at: number; sig?: string }
  | { type: "commit_forced"; at: number; sig?: string }
  | { type: "acked"; at: number; sig?: string }
  | { type: "tick"; at: number };

export type NextAction = "none" | "wait" | "request_commit" | "rescue" | "ack";

export function newCashout(owner: string, nonce: bigint, amount: bigint, at: number, fault = false, sig?: string): CashoutState {
  return { kind: "cashout", owner, nonce, amount, step: "requested", requestedAt: at, fault, history: [{ step: "requested", at, sig, layer: "ER" }] };
}

const push = (s: CashoutState, step: CashoutStep, at: number, sig?: string, layer?: "L1" | "ER"): CashoutState =>
  s.history.some((h) => h.step === step) ? { ...s, step } : { ...s, step, history: [...s.history, { step, at, sig, layer }] };

export function reduceCashout(s: CashoutState, o: Observation): CashoutState {
  if (s.step === "acked") return s;
  switch (o.type) {
    case "receipt_seen": {
      // Receipt is the single source of truth for "paid" — idempotent and terminal (until ack).
      if (s.step === "paid") return s;
      const committed = s.history.some((h) => h.step === "committed") ? s : push(s, "committed", o.at, undefined, "L1");
      const p = push(committed, "paid", o.at, o.sig, "L1");
      return { ...p, path: o.path === PAY_PATH.RESCUE ? "rescue" : "action" };
    }
    case "acked":
      return s.step === "paid" ? push(s, "acked", o.at, o.sig, "ER") : s;
    case "commit_seen":
      if (!o.pending || s.step === "paid") return s;
      if (s.step === "requested" || s.step === "commit_forced") return push(s, "committed", o.at, undefined, "L1");
      return s;
    case "commit_forced":
      return s.step === "requested" ? push(s, "commit_forced", o.at, o.sig, "ER") : s;
    case "rescue_sent":
      if (s.step === "paid") return s;
      return push(s.step === "committed" ? push(s, "action_dropped", o.at, undefined, "L1") : s, "rescue_sent", o.at, o.sig, "L1");
    case "tick": {
      // A committed withdrawal with no receipt after the grace period means the action was dropped.
      if (s.step === "committed" && o.at - s.requestedAt >= RESCUE_AFTER_MS) return push(s, "action_dropped", o.at, undefined, "L1");
      return s;
    }
    case "withdraw_requested":
      return s;
  }
}

/** What a page/keeper should do next for this cash-out, at time `now`. */
export function nextAction(s: CashoutState, now: number): NextAction {
  const age = now - s.requestedAt;
  switch (s.step) {
    case "requested":
      return age >= RESCUE_AFTER_MS ? "request_commit" : "wait";
    case "commit_forced":
      return "wait";
    case "committed":
      return age >= RESCUE_AFTER_MS ? "rescue" : "wait";
    case "action_dropped":
      return "rescue";
    case "rescue_sent":
      return age >= RESCUE_AFTER_MS * 3 ? "rescue" : "wait";
    case "paid":
      return "ack";
    case "acked":
      return "none";
  }
}

export function newDeposit(owner: string, nonce: bigint, amount: bigint, at: number, sig?: string): DepositState {
  return { kind: "deposit", owner, nonce, amount, step: "signed", signedAt: at, history: [{ step: "signed", at, sig, layer: "L1" }] };
}
export function reduceDeposit(s: DepositState, o: { type: "receipt_confirmed" | "ingested"; at: number; sig?: string }): DepositState {
  if (o.type === "receipt_confirmed" && s.step === "signed")
    return { ...s, step: "confirmed", history: [...s.history, { step: "confirmed", at: o.at, sig: o.sig, layer: "L1" }] };
  if (o.type === "ingested" && s.step !== "credited")
    return { ...s, step: "credited", history: [...s.history, ...(s.step === "signed" ? [{ step: "confirmed", at: o.at, layer: "L1" as const }] : []), { step: "credited", at: o.at, sig: o.sig, layer: "ER" }] };
  return s;
}

/**
 * Rebuild cash-out trackers from chain state alone (reload / new device):
 * every ring entry of the ER ledger + whether its receipt exists on L1.
 */
export function rebuildFromChain(
  owner: string,
  ring: { nonce: bigint; amount: bigint; requestedTs: bigint; state: number; fault: number }[],
  committedPending: Set<bigint>,
  receipts: Map<bigint, { path: number }>,
  now: number,
): CashoutState[] {
  const out: CashoutState[] = [];
  for (const e of ring) {
    if (e.state === 0) continue;
    let s = newCashout(owner, e.nonce, e.amount, Number(e.requestedTs) * 1000, e.fault !== 0);
    if (committedPending.has(e.nonce)) s = reduceCashout(s, { type: "commit_seen", at: now, pending: true });
    const r = receipts.get(e.nonce);
    if (r) s = reduceCashout(s, { type: "receipt_seen", at: now, path: r.path });
    if (e.state === 2) s = reduceCashout(s, { type: "acked", at: now });
    s = reduceCashout(s, { type: "tick", at: now });
    out.push(s);
  }
  return out.sort((a, b) => (a.nonce < b.nonce ? 1 : -1));
}
