/**
 * Byte-exact decoders for Landed accounts. Dependency-free (no Anchor runtime)
 * so the verifier runs in a browser Web Worker. Field order mirrors
 * `programs/landed/src/state.rs`; cross-checked against bytes dumped from
 * MagicSVM in test/layout.test.ts.
 */
import { PublicKey } from "@solana/web3.js";
import idl from "./idl/landed.json";
import naiveIdl from "./idl/naive_cashout.json";
import { HISTORY_SIZE, MAX_ENTRIES, RING_SIZE } from "./constants";

export class Reader {
  private v: DataView;
  constructor(public b: Uint8Array, public o = 0) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8() { return this.b[this.o++]; }
  bool() { return this.u8() !== 0; }
  u16() { const x = this.v.getUint16(this.o, true); this.o += 2; return x; }
  u32() { const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  u64() { const x = this.v.getBigUint64(this.o, true); this.o += 8; return x; }
  i64() { const x = this.v.getBigInt64(this.o, true); this.o += 8; return x; }
  bytes(n: number) { const x = this.b.slice(this.o, this.o + n); this.o += n; return x; }
  pk() { return new PublicKey(this.bytes(32)); }
  skip(n: number) { this.o += n; }
}

type IdlAcc = { name: string; discriminator: number[] };
const disc = (list: IdlAcc[], name: string) => new Uint8Array(list.find((a) => a.name === name)!.discriminator);
export const DISC = {
  Config: disc(idl.accounts as IdlAcc[], "Config"),
  UserMeta: disc(idl.accounts as IdlAcc[], "UserMeta"),
  DepositReceipt: disc(idl.accounts as IdlAcc[], "DepositReceipt"),
  WithdrawReceipt: disc(idl.accounts as IdlAcc[], "WithdrawReceipt"),
  Ledger: disc(idl.accounts as IdlAcc[], "Ledger"),
  Table: disc(idl.accounts as IdlAcc[], "Table"),
  EscrowAuth: disc(idl.accounts as IdlAcc[], "EscrowAuth"),
  NLedger: disc(naiveIdl.accounts as IdlAcc[], "NLedger"),
  NConfig: disc(naiveIdl.accounts as IdlAcc[], "NConfig"),
};

export function hasDisc(data: Uint8Array, d: Uint8Array) {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) return false;
  return true;
}
function check(data: Uint8Array, d: Uint8Array, name: string) {
  if (!hasDisc(data, d)) throw new Error(`not a ${name} account (discriminator mismatch)`);
  return new Reader(data, 8);
}

export interface Config {
  admin: PublicKey; pendingAdmin: PublicKey; mint: PublicKey; vault: PublicKey; erValidator: PublicKey;
  magicFeeVault: PublicKey; treasury: PublicKey; houseFeeBps: number; minChip: bigint; maxChip: bigint;
  maxPerPlayerRound: bigint; minWithdraw: bigint; roundSecs: number; vrfRetrySecs: number; vrfVoidSecs: number;
  paused: boolean; closeOnly: boolean; faultLab: boolean;
}
export function decodeConfig(data: Uint8Array): Config {
  const r = check(data, DISC.Config, "Config");
  return {
    admin: r.pk(), pendingAdmin: r.pk(), mint: r.pk(), vault: r.pk(), erValidator: r.pk(), magicFeeVault: r.pk(), treasury: r.pk(),
    houseFeeBps: r.u16(), minChip: r.u64(), maxChip: r.u64(), maxPerPlayerRound: r.u64(), minWithdraw: r.u64(),
    roundSecs: r.u32(), vrfRetrySecs: r.u32(), vrfVoidSecs: r.u32(), paused: r.bool(), closeOnly: r.bool(), faultLab: r.bool(),
  };
}

export interface UserMeta { owner: PublicKey; depositCount: bigint; depositTotal: bigint; lastFaucetTs: bigint; faucetTotal: bigint }
export function decodeUserMeta(data: Uint8Array): UserMeta {
  const r = check(data, DISC.UserMeta, "UserMeta");
  return { owner: r.pk(), depositCount: r.u64(), depositTotal: r.u64(), lastFaucetTs: r.i64(), faucetTotal: r.u64() };
}

export interface DepositReceipt { owner: PublicKey; nonce: bigint; amount: bigint; ts: bigint; slot: bigint }
export function decodeDepositReceipt(data: Uint8Array): DepositReceipt {
  const r = check(data, DISC.DepositReceipt, "DepositReceipt");
  return { owner: r.pk(), nonce: r.u64(), amount: r.u64(), ts: r.i64(), slot: r.u64() };
}

export interface WithdrawReceipt { owner: PublicKey; nonce: bigint; amount: bigint; destAta: PublicKey; path: number; rescuer: PublicKey; ts: bigint; slot: bigint }
export function decodeWithdrawReceipt(data: Uint8Array): WithdrawReceipt {
  const r = check(data, DISC.WithdrawReceipt, "WithdrawReceipt");
  return { owner: r.pk(), nonce: r.u64(), amount: r.u64(), destAta: r.pk(), path: r.u8(), rescuer: r.pk(), ts: r.i64(), slot: r.u64() };
}

export interface PendingWithdrawal { nonce: bigint; amount: bigint; requestedTs: bigint; state: number; fault: number }
export interface Ledger {
  owner: PublicKey; available: bigint; ingestedCount: bigint; ingestedTotal: bigint; withdrawNonce: bigint;
  withdrawRequestedTotal: bigint; creditedTotal: bigint; debitedTotal: bigint; ring: PendingWithdrawal[];
  session: { signer: PublicKey; expiresTs: bigint; cap: bigint; spent: bigint };
  stats: { rounds: bigint; wins: bigint; wagered: bigint; won: bigint };
}
export function decodeLedger(data: Uint8Array): Ledger {
  const r = check(data, DISC.Ledger, "Ledger");
  const owner = r.pk();
  const [available, ingestedCount, ingestedTotal, withdrawNonce, withdrawRequestedTotal, creditedTotal, debitedTotal] =
    [r.u64(), r.u64(), r.u64(), r.u64(), r.u64(), r.u64(), r.u64()];
  const ring: PendingWithdrawal[] = [];
  for (let i = 0; i < RING_SIZE; i++) ring.push({ nonce: r.u64(), amount: r.u64(), requestedTs: r.i64(), state: r.u8(), fault: r.u8() });
  const session = { signer: r.pk(), expiresTs: r.i64(), cap: r.u64(), spent: r.u64() };
  const stats = { rounds: r.u64(), wins: r.u64(), wagered: r.u64(), won: r.u64() };
  return { owner, available, ingestedCount, ingestedTotal, withdrawNonce, withdrawRequestedTotal, creditedTotal, debitedTotal, ring, session, stats };
}

export interface Entry { player: PublicKey; amount: bigint }
export interface RoundResult {
  roundId: bigint; pot: bigint; fee: bigint; vrfNonce: bigint; settledTs: bigint; winner: PublicKey;
  randomness: Uint8Array; entriesHash: Uint8Array; outcome: number; winnerIdx: number; entryCount: number; closedBy: number;
}
export interface Table {
  id: bigint; roundId: bigint; pot: bigint; vrfNonce: bigint; historyLen: bigint; roundsSettled: bigint; roundsVoided: bigint;
  closesByCrank: bigint; closesByKeeper: bigint; staleCallbacks: bigint; vrfRetries: bigint; openedTs: bigint; closesTs: bigint;
  vrfFirstRequestTs: bigint; vrfLastRequestTs: bigint; crankTaskId: bigint; lastCrankTs: bigint; treasury: PublicKey;
  entries: Entry[]; history: RoundResult[]; entriesHash: Uint8Array; randomness: Uint8Array; roundSecs: number;
  vrfRetrySecs: number; vrfVoidSecs: number; houseFeeBps: number; status: number; entryCount: number; vrfAttempts: number;
  winnerIdx: number; closedBy: number;
}
export function decodeTable(data: Uint8Array): Table {
  const r = check(data, DISC.Table, "Table");
  const u = () => r.u64();
  const [id, roundId, pot, vrfNonce, historyLen, roundsSettled, roundsVoided, closesByCrank, closesByKeeper, staleCallbacks, vrfRetries] =
    [u(), u(), u(), u(), u(), u(), u(), u(), u(), u(), u()];
  const [openedTs, closesTs, vrfFirstRequestTs, vrfLastRequestTs, crankTaskId, lastCrankTs] = [r.i64(), r.i64(), r.i64(), r.i64(), r.i64(), r.i64()];
  const treasury = r.pk();
  const all: Entry[] = [];
  for (let i = 0; i < MAX_ENTRIES; i++) all.push({ player: r.pk(), amount: r.u64() });
  const history: RoundResult[] = [];
  for (let i = 0; i < HISTORY_SIZE; i++) {
    const h = {
      roundId: r.u64(), pot: r.u64(), fee: r.u64(), vrfNonce: r.u64(), settledTs: r.i64(), winner: r.pk(),
      randomness: r.bytes(32), entriesHash: r.bytes(32), outcome: r.u8(), winnerIdx: r.u8(), entryCount: r.u8(), closedBy: r.u8(),
    };
    r.skip(4);
    history.push(h);
  }
  const entriesHash = r.bytes(32);
  const randomness = r.bytes(32);
  const roundSecs = r.u32(), vrfRetrySecs = r.u32(), vrfVoidSecs = r.u32(), houseFeeBps = r.u16();
  const status = r.u8(), entryCount = r.u8(), vrfAttempts = r.u8(), winnerIdx = r.u8(), closedBy = r.u8();
  return {
    id, roundId, pot, vrfNonce, historyLen, roundsSettled, roundsVoided, closesByCrank, closesByKeeper, staleCallbacks, vrfRetries,
    openedTs, closesTs, vrfFirstRequestTs, vrfLastRequestTs, crankTaskId, lastCrankTs, treasury,
    entries: all.slice(0, entryCount), history, entriesHash, randomness, roundSecs, vrfRetrySecs, vrfVoidSecs, houseFeeBps,
    status, entryCount, vrfAttempts, winnerIdx, closedBy,
  };
}
/** History in chronological order (the ring buffer unrolled). */
export function orderedHistory(t: Table): RoundResult[] {
  const n = Number(t.historyLen);
  const len = Math.min(n, HISTORY_SIZE);
  const out: RoundResult[] = [];
  for (let k = n - len; k < n; k++) out.push(t.history[k % HISTORY_SIZE]);
  return out;
}

export interface NLedger { owner: PublicKey; balance: bigint; fundedTotal: bigint; requestedTotal: bigint; cashoutCount: bigint }
export function decodeNLedger(data: Uint8Array): NLedger {
  const r = check(data, DISC.NLedger, "NLedger");
  return { owner: r.pk(), balance: r.u64(), fundedTotal: r.u64(), requestedTotal: r.u64(), cashoutCount: r.u64() };
}

export function decodeTokenAmount(data: Uint8Array): bigint {
  if (data.length < 72) return 0n;
  return new DataView(data.buffer, data.byteOffset).getBigUint64(64, true);
}
export function decodeTokenOwner(data: Uint8Array): PublicKey {
  return new PublicKey(data.slice(32, 64));
}
