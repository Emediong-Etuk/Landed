/**
 * LandedClient: connections + chain reads + every permissionless recovery step.
 * Shared by the web app (guest burner / wallet), the keeper and the devnet
 * campaigns, so "works without our keeper" is literally the same code.
 */
import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { CLOSED_BY, DEVNET_EU_VALIDATOR, ENDPOINTS, SLOT_STATE, TABLE_STATUS, WATCHDOG_GRACE_SECS } from "./constants";
import { addresses, Addrs, ix } from "./ix";
import {
  decodeConfig,
  decodeLedger,
  decodeTable,
  decodeTokenAmount,
  decodeUserMeta,
  decodeWithdrawReceipt,
  Ledger,
  Table,
} from "./layout";
import { ata, pda } from "./pda";
import type { Layer } from "./explorer";

export type Signer = Keypair | { publicKey: PublicKey; signTransaction(tx: Transaction): Promise<Transaction> };

export interface SendResult { sig: string; latencyMs: number; slot: number | null; layer: Layer; ok: boolean; err?: string; logs?: string[] }

export interface ClientOptions {
  l1Url?: string;
  erUrl?: string;
  erWsUrl?: string;
  validator?: PublicKey;
  tableId?: bigint;
  commitment?: Commitment;
  onSend?: (label: string, r: SendResult) => void;
}

export class LandedClient {
  readonly l1: Connection;
  readonly er: Connection;
  readonly a: Addrs;
  readonly validator: PublicKey;
  readonly tableId: bigint;
  private onSend?: ClientOptions["onSend"];

  constructor(o: ClientOptions = {}) {
    const ep = ENDPOINTS.devnet;
    const commitment = o.commitment ?? "confirmed";
    this.l1 = new Connection(o.l1Url ?? ep.l1, { commitment });
    this.er = new Connection(o.erUrl ?? ep.er, { commitment, wsEndpoint: o.erWsUrl ?? ep.erWs });
    this.validator = o.validator ?? DEVNET_EU_VALIDATOR;
    this.tableId = o.tableId ?? 1n;
    this.a = addresses(this.validator, this.tableId);
    this.onSend = o.onSend;
  }

  conn(layer: Layer) { return layer === "L1" ? this.l1 : this.er; }

  // ------------------------------------------------------------------ sending

  async send(layer: Layer, ixs: TransactionInstruction[], signers: Signer[], label = "tx"): Promise<SendResult> {
    const c = this.conn(layer);
    const t0 = performance.now();
    let sig = "";
    try {
      const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash();
      const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
      const kps = signers.filter((s): s is Keypair => s instanceof Keypair);
      if (kps.length) tx.partialSign(...kps);
      let signed = tx;
      for (const s of signers) if (!(s instanceof Keypair)) signed = await s.signTransaction(signed);
      sig = await c.sendRawTransaction(signed.serialize(), { skipPreflight: layer === "ER" ? false : false, maxRetries: 3 });
      const conf = await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      const latencyMs = Math.round(performance.now() - t0);
      if (conf.value.err) {
        const r: SendResult = { sig, latencyMs, slot: conf.context.slot, layer, ok: false, err: JSON.stringify(conf.value.err) };
        r.logs = await this.logs(layer, sig);
        this.onSend?.(label, r);
        return r;
      }
      const r: SendResult = { sig, latencyMs, slot: conf.context.slot, layer, ok: true };
      this.onSend?.(label, r);
      return r;
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      const logs = (e as { logs?: string[] })?.logs;
      const r: SendResult = { sig, latencyMs: Math.round(performance.now() - t0), slot: null, layer, ok: false, err, logs };
      this.onSend?.(label, r);
      return r;
    }
  }

  async mustSend(layer: Layer, ixs: TransactionInstruction[], signers: Signer[], label = "tx"): Promise<SendResult> {
    const r = await this.send(layer, ixs, signers, label);
    if (!r.ok) throw new Error(`${label} failed on ${layer}: ${r.err}\n${(r.logs ?? []).join("\n")}`);
    return r;
  }

  async logs(layer: Layer, sig: string): Promise<string[]> {
    try {
      const t = await this.conn(layer).getTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
      return t?.meta?.logMessages ?? [];
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------ reads

  private async data(layer: Layer, k: PublicKey): Promise<Uint8Array | null> {
    const a = await this.conn(layer).getAccountInfo(k, "confirmed");
    return a && a.lamports > 0 ? new Uint8Array(a.data) : null;
  }
  async config() { const d = await this.data("L1", this.a.config); return d ? decodeConfig(d) : null; }
  async table(layer: Layer = "ER"): Promise<Table | null> { const d = await this.data(layer, this.a.table); return d ? decodeTable(d) : null; }
  async ledger(owner: PublicKey, layer: Layer = "ER"): Promise<Ledger | null> {
    const d = await this.data(layer, pda.ledger(owner));
    return d ? decodeLedger(d) : null;
  }
  async userMeta(owner: PublicKey) { const d = await this.data("L1", pda.user(owner)); return d ? decodeUserMeta(d) : null; }
  async receipt(owner: PublicKey, n: bigint) { const d = await this.data("L1", pda.withdraw(owner, n)); return d ? decodeWithdrawReceipt(d) : null; }
  async walletBalance(owner: PublicKey) { const d = await this.data("L1", ata(owner, this.a.mint)); return d ? decodeTokenAmount(d) : 0n; }
  async sol(owner: PublicKey) { return BigInt(await this.l1.getBalance(owner, "confirmed")); }

  /** The three balances of the two truths. */
  async balances(owner: PublicKey) {
    const [er, l1, wallet] = await Promise.all([this.ledger(owner, "ER"), this.ledger(owner, "L1"), this.walletBalance(owner)]);
    const onTheWay = (er?.ring ?? []).filter((s) => s.state === SLOT_STATE.PENDING).reduce((x, s) => x + s.amount, 0n);
    return { rollup: er?.available ?? 0n, wallet, onTheWay, er, l1 };
  }

  // ------------------------------------------------------------------ onboarding

  /** init_user + faucet + deposit + delegate — one L1 transaction. Then ingest in the ER. */
  async onboard(owner: Signer, deposit: bigint): Promise<SendResult[]> {
    const o = owner.publicKey;
    const meta = await this.userMeta(o);
    const out: SendResult[] = [];
    const ixs: TransactionInstruction[] = [];
    let n = 0n;
    if (!meta) ixs.push(ix.initUser(o), ix.faucet(this.a, o));
    else n = meta.depositCount;
    ixs.push(ix.deposit(this.a, o, n, deposit));
    const ledgerInfo = await this.l1.getAccountInfo(pda.ledger(o));
    const delegated = ledgerInfo && !ledgerInfo.owner.equals(pda.config()) && ledgerInfo.owner.toBase58() === "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
    if (!delegated) ixs.push(ix.delegateLedger(this.a, o, o));
    out.push(await this.mustSend("L1", ixs, [owner], "onboard"));
    out.push(await this.ingestAll(o, owner));
    return out;
  }

  /** Ingest every L1 deposit receipt not yet credited in the ER (permissionless; retries while the ER clones it). */
  async ingestAll(owner: PublicKey, payer: Signer, timeoutMs = 20_000): Promise<SendResult> {
    const deadline = Date.now() + timeoutMs;
    let last: SendResult | null = null;
    while (Date.now() < deadline) {
      const [meta, led] = await Promise.all([this.userMeta(owner), this.ledger(owner, "ER")]);
      if (!meta || !led) { await sleep(500); continue; }
      if (led.ingestedCount >= meta.depositCount) return last ?? { sig: "", latencyMs: 0, slot: null, layer: "ER", ok: true };
      const ixs = [];
      for (let n = led.ingestedCount; n < meta.depositCount; n++) ixs.push(ix.ingestDeposit(owner, n));
      last = await this.send("ER", ixs, [payer], "ingest");
      if (last.ok) continue;
      await sleep(700);
    }
    throw new Error(`ingest timed out: ${last?.err}`);
  }

  // ------------------------------------------------------------------ game

  enter(authority: Signer, owner: PublicKey, amount: bigint, sessionToken?: PublicKey | null) {
    return this.send("ER", [ix.enterRound(this.a, authority.publicKey, owner, amount, sessionToken)], [authority], "enter_round");
  }

  /**
   * Watchdog: does whatever permissionless step the table needs right now.
   * Returns the action taken (or "none"). Safe to call from many clients at once.
   */
  async tick(payer: Signer, kind: number = CLOSED_BY.KEEPER): Promise<{ action: string; r?: SendResult; table?: Table }> {
    const t = await this.table("ER");
    if (!t) return { action: "no-table" };
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (t.status === TABLE_STATUS.OPEN && t.entryCount > 0 && t.closesTs > 0n && now >= t.closesTs + BigInt(WATCHDOG_GRACE_SECS)) {
      return { action: "close", r: await this.send("ER", [ix.closeRound(this.a, kind)], [payer], "close_round"), table: t };
    }
    if (t.status === TABLE_STATUS.DRAWN) {
      const w = t.entries[t.winnerIdx].player;
      return { action: "settle", r: await this.send("ER", [ix.settleRound(this.a, t.roundId, w)], [payer], "settle_round"), table: t };
    }
    if (t.status === TABLE_STATUS.AWAITING_VRF) {
      if (now >= t.vrfFirstRequestTs + BigInt(t.vrfVoidSecs)) {
        const owners = t.entries.map((e) => e.player);
        return { action: "void", r: await this.send("ER", [ix.computeUnitLimit(1_400_000), ix.voidRound(this.a, t.roundId, owners)], [payer], "void_round"), table: t };
      }
      if (t.vrfAttempts < 3 && now >= t.vrfLastRequestTs + BigInt(t.vrfRetrySecs)) {
        return { action: "retry", r: await this.send("ER", [ix.retryVrf(this.a)], [payer], "retry_vrf"), table: t };
      }
    }
    return { action: "none", table: t };
  }

  // ------------------------------------------------------------------ cash-out

  async cashOut(authority: Signer, owner: PublicKey, amount: bigint, injectFault = false, sessionToken?: PublicKey | null) {
    const led = await this.ledger(owner, "ER");
    const nonce = led?.withdrawNonce ?? 0n;
    const r = await this.send("ER", [ix.requestWithdraw(this.a, authority.publicKey, owner, amount, injectFault, sessionToken)], [authority], "request_withdraw");
    return { nonce, r };
  }

  /** Has the committed L1 ledger got this nonce Pending? */
  async committedPending(owner: PublicKey, nonce: bigint): Promise<boolean> {
    const l1 = await this.ledger(owner, "L1");
    return !!l1?.ring.find((s) => s.nonce === nonce && s.state === SLOT_STATE.PENDING);
  }

  /**
   * Drive one withdrawal to "paid" using only permissionless steps:
   * receipt? → done. committed? → rescue. not committed? → request_commit, then rescue.
   */
  async ensurePaid(owner: PublicKey, nonce: bigint, payer: Signer): Promise<{ path: "action" | "rescue" | "pending"; r?: SendResult }> {
    const rec = await this.receipt(owner, nonce);
    if (rec) return { path: rec.path === 1 ? "rescue" : "action" };
    if (!(await this.committedPending(owner, nonce))) {
      const c = await this.send("ER", [ix.requestCommit(this.a, owner)], [payer], "request_commit");
      if (!c.ok) return { path: "pending", r: c };
      for (let i = 0; i < 20 && !(await this.committedPending(owner, nonce)); i++) await sleep(500);
    }
    const r = await this.send("L1", [ix.finalizeWithdraw(this.a, payer.publicKey, owner, nonce)], [payer], "finalize_withdraw");
    if (!r.ok) {
      const again = await this.receipt(owner, nonce); // action may have won the race
      if (again) return { path: again.path === 1 ? "rescue" : "action" };
      return { path: "pending", r };
    }
    return { path: "rescue", r };
  }

  /** Ack every paid-but-unacked ring slot (lets slots be reused). */
  async ackPaid(owner: PublicKey, payer: Signer): Promise<SendResult | null> {
    const led = await this.ledger(owner, "ER");
    if (!led) return null;
    const ixs: TransactionInstruction[] = [];
    for (const s of led.ring) {
      if (s.state !== SLOT_STATE.PENDING) continue;
      if (await this.receipt(owner, s.nonce)) ixs.push(ix.ackWithdrawal(owner, s.nonce));
    }
    if (!ixs.length) return null;
    return this.send("ER", ixs.slice(0, 8), [payer], "ack_withdrawal");
  }

  async waitFor<T>(f: () => Promise<T | null | undefined | false>, timeoutMs = 30_000, everyMs = 400): Promise<T | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = await f();
      if (v) return v as T;
      await sleep(everyMs);
    }
    return null;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
