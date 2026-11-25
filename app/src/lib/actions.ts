"use client";
/**
 * Every user-visible action. Errors become one sentence + one recovery button.
 * All recovery steps are permissionless and run from the page itself, so the
 * app works without our keeper.
 */
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  CLOSED_BY, ONE_DUSDC, PAY_PATH, RESCUE_AFTER_MS, ix, newCashout, nextAction, rebuildFromChain, reduceCashout, sleep, pda,
  SLOT_STATE, type CashoutState,
} from "@landed/sdk";
import { getClient } from "./chain";
import { createGuest, loadGuest } from "./guest";
import { useApp } from "./store";

const st = () => useApp.getState();
const fail = (message: string, label?: string, run?: () => void) => st().set({ error: { message, action: label && run ? { label, run } : undefined }, progress: null });

async function topUp(pubkey: PublicKey) {
  const r = await fetch("/api/guest/topup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pubkey: pubkey.toBase58() }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) throw new Error(j.error ?? "gas top-up unavailable");
  return j;
}

/** One click: burner → gas → 100 dUSDC → deposit → delegate → ingest. Zero signatures. */
export async function playAsGuest() {
  const c = getClient();
  try {
    st().set({ error: null, progress: { step: 1, total: 3, label: "Making you a guest wallet…" } });
    const kp = (await loadGuest()) ?? (await createGuest());
    st().set({ mode: "guest", owner: kp.publicKey, actor: kp });
    const [led, sol] = await Promise.all([c.ledger(kp.publicKey, "ER").catch(() => null), c.sol(kp.publicKey).catch(() => 0n)]);
    if (led && led.available + (await c.walletBalance(kp.publicKey)) > 0n) {
      st().set({ progress: null, ready: true });
      void resumeOps();
      return;
    }
    if (sol < 10_000_000n) {
      st().set({ progress: { step: 2, total: 3, label: "Topping up a little gas…" } });
      await topUp(kp.publicKey);
      await c.waitFor(async () => (await c.sol(kp.publicKey)) >= 10_000_000n, 30_000, 800);
    }
    st().set({ progress: { step: 3, total: 3, label: "Getting your chips ready…" } });
    // Keep 30 dUSDC in the wallet so the Fault Lab can open a naive-baseline account.
    await c.onboard(kp, 70n * ONE_DUSDC);
    st().set({ progress: null, ready: true });
  } catch (e) {
    fail(`We couldn't finish setting up your guest seat (${short(e)}).`, "Try again", () => void playAsGuest());
  }
}

/**
 * Wallet users: L1 setup + MagicBlock SessionTokenV2 + ER session grant, signed
 * with ONE signAllTransactions popup. Afterwards drops/cash-outs are popup-free.
 */
export async function onboardWallet(owner: PublicKey, signAll: (txs: Transaction[]) => Promise<Transaction[]>) {
  const c = getClient();
  try {
    st().set({ error: null, mode: "wallet", owner, progress: { step: 1, total: 3, label: "Preparing your setup…" } });
    const session = Keypair.generate();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const expires = now + 8n * 3600n;
    const meta = await c.userMeta(owner);
    const l1Ixs = [];
    let n = 0n;
    if (!meta) l1Ixs.push(ix.initUser(owner), ix.faucet(c.a, owner));
    else n = meta.depositCount;
    const wal = await c.walletBalance(owner);
    const amount = meta ? wal : 100n * ONE_DUSDC;
    if (amount > 0n) l1Ixs.push(ix.deposit(c.a, owner, n, amount));
    const ledInfo = await c.l1.getAccountInfo(pda.ledger(owner));
    if (!ledInfo || ledInfo.owner.toBase58() !== "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh") l1Ixs.push(ix.delegateLedger(c.a, owner, owner));
    const { token, ix: createSession } = ix.createSessionV2(owner, session.publicKey, owner, expires);
    const l1bh = await c.l1.getLatestBlockhash();
    const erbh = await c.er.getLatestBlockhash();
    const t1 = new Transaction({ feePayer: owner, ...l1bh }).add(...l1Ixs);
    const t2 = new Transaction({ feePayer: owner, ...l1bh }).add(createSession);
    t2.partialSign(session);
    const t3 = new Transaction({ feePayer: owner, ...erbh }).add(ix.setSession(owner, session.publicKey, 100n * ONE_DUSDC, expires));
    st().set({ progress: { step: 2, total: 3, label: "Approve once in your wallet…" } });
    const signed = await signAll(l1Ixs.length ? [t1, t2, t3] : [t2, t3]);
    st().set({ progress: { step: 3, total: 3, label: "Getting your chips ready…" } });
    const er = signed.pop()!;
    for (const t of signed) {
      const sig = await c.l1.sendRawTransaction(t.serialize());
      await c.l1.confirmTransaction({ signature: sig, ...l1bh }, "confirmed");
    }
    await c.waitFor(async () => !!(await c.er.getAccountInfo(pda.ledger(owner))), 30_000, 600);
    await sleep(600);
    const sig = await c.er.sendRawTransaction(er.serialize());
    await c.er.confirmTransaction({ signature: sig, ...erbh }, "confirmed");
    await c.ingestAll(owner, session);
    st().set({ actor: session, sessionToken: token, progress: null, ready: true });
  } catch (e) {
    fail(`Wallet setup didn't complete (${short(e)}).`, "Try again", () => void onboardWallet(owner, signAll));
  }
}

export async function drop(amountD: number) {
  const { actor, owner, sessionToken } = st();
  if (!actor || !owner) return;
  const c = getClient();
  const r = await c.enter(actor, owner, BigInt(amountD) * ONE_DUSDC, sessionToken);
  st().pushLatency(r.latencyMs);
  st().set({ erSlow: r.latencyMs > 3000 });
  if (!r.ok) {
    const m = r.err ?? "";
    const why = m.includes("RoundClosed") || m.includes("RoundNotOpen") ? "This round just closed — your chips weren't taken. Next round starts in a moment."
      : m.includes("InsufficientBalance") ? "Not enough playable balance for that chip."
      : m.includes("PlayerCapExceeded") ? "You've hit the 100 dUSDC per-round cap."
      : m.includes("TableFull") ? "This round is full (32 players). Catch the next one."
      : m.includes("SessionCap") ? "Your session spend cap is used up. Reconnect to refresh it."
      : "That drop didn't go through.";
    fail(why);
  }
  return r;
}

/** Page-side watchdog: any client can close/retry/void/settle a due round. */
export async function watchdogTick() {
  const { actor } = st();
  if (!actor) return;
  try {
    await getClient().tick(actor, CLOSED_BY.PLAYER);
  } catch {
    st().set({ erSlow: true });
  }
}

export async function cashOut(amountD: bigint, injectFault = false) {
  const { actor, owner, sessionToken } = st();
  if (!actor || !owner) return;
  const c = getClient();
  const { nonce, r } = await c.cashOut(actor, owner, amountD, injectFault, sessionToken);
  if (!r.ok) {
    fail(r.err?.includes("RingFull") ? "Too many cash-outs still landing — give them a few seconds." : "That cash-out didn't start. Nothing left your balance.");
    return;
  }
  const op = newCashout(owner.toBase58(), nonce, amountD, Date.now(), injectFault, r.sig);
  st().upsertOp(op);
  void follow(op);
}

/** Drives one cash-out to Paid using only chain observations + permissionless steps. */
export async function follow(start: CashoutState) {
  const c = getClient();
  const owner = new PublicKey(start.owner);
  let s = start;
  const end = Date.now() + 5 * 60_000;
  while (Date.now() < end && s.step !== "acked") {
    const now = Date.now();
    const rec = await c.receipt(owner, s.nonce).catch(() => null);
    if (rec) s = reduceCashout(s, { type: "receipt_seen", at: now, path: rec.path });
    else if (await c.committedPending(owner, s.nonce).catch(() => false)) s = reduceCashout(s, { type: "commit_seen", at: now, pending: true });
    s = reduceCashout(s, { type: "tick", at: now });
    st().upsertOp(s);
    const next = nextAction(s, now);
    const { actor, mode } = st();
    if (next === "ack" && actor) {
      const r = await c.send("ER", [ix.ackWithdrawal(owner, s.nonce)], [actor], "ack");
      if (r.ok) s = reduceCashout(s, { type: "acked", at: Date.now(), sig: r.sig });
      st().upsertOp(s);
    } else if ((next === "rescue" || next === "request_commit") && actor && mode === "guest") {
      if (next === "request_commit") s = reduceCashout(s, { type: "commit_forced", at: now });
      else s = reduceCashout(s, { type: "rescue_sent", at: now });
      st().upsertOp(s);
      await c.ensurePaid(owner, s.nonce, actor).catch(() => null);
    }
    await sleep(s.step === "paid" ? 1500 : 700);
  }
}

/** Manual "Rescue my payout" (wallet users sign; guests are automatic). */
export async function rescue(op: CashoutState, payer?: Keypair) {
  const p = payer ?? st().actor;
  if (!p) return;
  const r = await getClient().ensurePaid(new PublicKey(op.owner), op.nonce, p);
  if (r.path === "pending") fail("The rescue didn't land yet — the rollup may still be committing. Try again in a few seconds.", "Retry", () => void rescue(op, p));
}

/** Rebuild the Settlement Rail from chain state after a reload / on a new device. */
export async function resumeOps() {
  const { owner } = st();
  if (!owner) return;
  const c = getClient();
  const [er, l1] = await Promise.all([c.ledger(owner, "ER"), c.ledger(owner, "L1")]);
  if (!er) return;
  const pending = new Set((l1?.ring ?? []).filter((x) => x.state === SLOT_STATE.PENDING).map((x) => x.nonce));
  const receipts = new Map<bigint, { path: number }>();
  for (const e of er.ring) {
    if (e.state === SLOT_STATE.EMPTY) continue;
    const r = await c.receipt(owner, e.nonce).catch(() => null);
    if (r) receipts.set(e.nonce, { path: r.path ?? PAY_PATH.ACTION });
  }
  const ops = rebuildFromChain(owner.toBase58(), er.ring, pending, receipts, Date.now());
  st().set({ ops });
  for (const o of ops) if (o.step !== "acked") void follow(o);
}

function short(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  return m.split("\n")[0].slice(0, 120);
}
export { RESCUE_AFTER_MS };
