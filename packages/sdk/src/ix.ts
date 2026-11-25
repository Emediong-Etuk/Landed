/**
 * Explicit instruction builders for Landed + the naive baseline. Account lists
 * mirror `tests/magicsvm/tests/common/mod.rs` exactly (the same order the
 * program's `#[derive(Accounts)]` structs expect).
 */
import { Buffer } from "buffer";
import { AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
import idl from "./idl/landed.json";
import naiveIdl from "./idl/naive_cashout.json";
import {
  ATA_PROGRAM_ID,
  CLOSED_BY,
  COMPUTE_BUDGET_ID,
  DELEGATION_PROGRAM_ID,
  INSTRUCTIONS_SYSVAR,
  LANDED_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  NAIVE_PROGRAM_ID,
  SESSION_KEYS_PROGRAM_ID,
  SLOT_HASHES_SYSVAR,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  VRF_EPHEMERAL_QUEUE,
  VRF_PROGRAM_ID,
} from "./constants";
import { ata, dlpPda, naivePda, pda, sessionTokenV2, u64le } from "./pda";
import { sha256 } from "@noble/hashes/sha256";

type IdlIx = { name: string; discriminator: number[] };
const ixDisc = (list: IdlIx[], name: string) => {
  const f = list.find((i) => i.name === name);
  if (!f) throw new Error(`unknown instruction ${name}`);
  return f.discriminator;
};

class W {
  b: number[] = [];
  disc(d: number[]) { this.b.push(...d); return this; }
  u8(x: number) { this.b.push(x & 0xff); return this; }
  bool(x: boolean) { return this.u8(x ? 1 : 0); }
  u16(x: number) { this.b.push(x & 0xff, (x >> 8) & 0xff); return this; }
  u32(x: number) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, x, true); this.b.push(...a); return this; }
  u64(x: bigint | number) { this.b.push(...u64le(x)); return this; }
  i64(x: bigint | number) { const a = new Uint8Array(8); new DataView(a.buffer).setBigInt64(0, BigInt(x), true); this.b.push(...a); return this; }
  pk(p: PublicKey) { this.b.push(...p.toBytes()); return this; }
  bytes(x: Uint8Array) { this.b.push(...x); return this; }
  opt<T>(v: T | null | undefined, f: (w: W, v: T) => void) { if (v === null || v === undefined) this.u8(0); else { this.u8(1); f(this, v); } return this; }
  done() { return Buffer.from(this.b); }
}
const L = (name: string) => new W().disc(ixDisc(idl.instructions as IdlIx[], name));
const N = (name: string) => new W().disc(ixDisc(naiveIdl.instructions as IdlIx[], name));

const m = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });
const lix = (keys: AccountMeta[], data: Buffer) => new TransactionInstruction({ programId: LANDED_PROGRAM_ID, keys, data });
const nix = (keys: AccountMeta[], data: Buffer) => new TransactionInstruction({ programId: NAIVE_PROGRAM_ID, keys, data });
/** Anchor's placeholder for an omitted `Option<Account>` is the program id. */
const optional = (k?: PublicKey | null) => m(k ?? LANDED_PROGRAM_ID);

export interface Addrs {
  config: PublicKey; mint: PublicKey; mintAuth: PublicKey; vault: PublicKey; vaultAuth: PublicKey;
  escrowAuth: PublicKey; escrow: PublicKey; treasury: PublicKey; treasuryLedger: PublicKey; feeVault: PublicKey; table: PublicKey;
}
export function addresses(validator: PublicKey, tableId: bigint = 1n): Addrs {
  const escrowAuth = pda.escrowAuth();
  return {
    config: pda.config(), mint: pda.mint(), mintAuth: pda.mintAuth(), vault: pda.vault(), vaultAuth: pda.vaultAuth(),
    escrowAuth, escrow: dlpPda.ephemeralBalance(escrowAuth), treasury: pda.treasury(), treasuryLedger: pda.treasuryLedger(),
    feeVault: dlpPda.magicFeeVault(validator), table: pda.table(tableId),
  };
}

function delegateKeys(payerOrAdmin: PublicKey, extra: AccountMeta[], account: PublicKey, owner = LANDED_PROGRAM_ID): AccountMeta[] {
  return [
    m(payerOrAdmin, true, true),
    ...extra,
    m(dlpPda.buffer(account, owner), true),
    m(dlpPda.record(account), true),
    m(dlpPda.metadata(account), true),
    m(account, true),
    m(owner),
    m(DELEGATION_PROGRAM_ID),
    m(SYSTEM_PROGRAM_ID),
  ];
}

export interface ConfigParams {
  erValidator: PublicKey; houseFeeBps: number; minChip: bigint; maxChip: bigint; maxPerPlayerRound: bigint;
  minWithdraw: bigint; roundSecs: number; vrfRetrySecs: number; vrfVoidSecs: number;
}

export const ix = {
  // ------------------------------------------------------------- admin / setup (L1)
  initializeConfig(a: Addrs, admin: PublicKey, p: ConfigParams) {
    const d = L("initialize_config").pk(p.erValidator).u16(p.houseFeeBps).u64(p.minChip).u64(p.maxChip).u64(p.maxPerPlayerRound)
      .u64(p.minWithdraw).u32(p.roundSecs).u32(p.vrfRetrySecs).u32(p.vrfVoidSecs).done();
    return lix([m(admin, true, true), m(a.config, true), m(a.mint, true), m(a.mintAuth), m(a.vault, true), m(a.vaultAuth), m(TOKEN_PROGRAM_ID), m(SYSTEM_PROGRAM_ID)], d);
  },
  initializeEscrowAndTreasury(a: Addrs, admin: PublicKey, feePayerLamports: bigint) {
    return lix([m(admin, true, true), m(a.config), m(a.escrowAuth, true), m(a.treasuryLedger, true), m(SYSTEM_PROGRAM_ID)],
      L("initialize_escrow_and_treasury").u64(feePayerLamports).done());
  },
  delegateEscrowAuth(a: Addrs, admin: PublicKey) {
    return lix(delegateKeys(admin, [m(a.config)], a.escrowAuth), L("delegate_escrow_auth").done());
  },
  createTable(a: Addrs, admin: PublicKey, id: bigint) {
    return lix([m(admin, true, true), m(a.config), m(pda.table(id), true), m(SYSTEM_PROGRAM_ID)], L("create_table").u64(id).done());
  },
  delegateTable(a: Addrs, admin: PublicKey, id: bigint) {
    return lix(delegateKeys(admin, [m(a.config)], pda.table(id)), L("delegate_table").u64(id).done());
  },
  setFlags(a: Addrs, admin: PublicKey, paused: boolean, closeOnly: boolean) {
    return lix([m(admin, false, true), m(a.config, true)], L("set_flags").bool(paused).bool(closeOnly).done());
  },
  /** DLP TopUpEphemeralBalance: funds `[balance, authority, 255]`. */
  topUpEscrow(payer: PublicKey, authority: PublicKey, lamports: bigint) {
    const data = Buffer.concat([Buffer.from(u64le(9)), Buffer.from(u64le(lamports)), Buffer.from([255])]);
    return new TransactionInstruction({
      programId: DELEGATION_PROGRAM_ID,
      keys: [m(payer, true, true), m(authority), m(dlpPda.ephemeralBalance(authority), true), m(SYSTEM_PROGRAM_ID)],
      data,
    });
  },

  // ------------------------------------------------------------- player onboarding (L1)
  initUser(owner: PublicKey) {
    return lix([m(owner, true, true), m(pda.user(owner), true), m(pda.ledger(owner), true), m(SYSTEM_PROGRAM_ID)], L("init_user").done());
  },
  faucet(a: Addrs, owner: PublicKey) {
    return lix([m(owner, true, true), m(a.config), m(pda.user(owner), true), m(a.mint, true), m(a.mintAuth), m(ata(owner, a.mint), true),
      m(TOKEN_PROGRAM_ID), m(ATA_PROGRAM_ID), m(SYSTEM_PROGRAM_ID)], L("faucet").done());
  },
  deposit(a: Addrs, owner: PublicKey, n: bigint, amount: bigint) {
    return lix([m(owner, true, true), m(a.config), m(pda.user(owner), true), m(pda.deposit(owner, n), true), m(a.mint),
      m(ata(owner, a.mint), true), m(a.vault, true), m(TOKEN_PROGRAM_ID), m(SYSTEM_PROGRAM_ID)], L("deposit").u64(amount).done());
  },
  delegateLedger(a: Addrs, payer: PublicKey, owner: PublicKey) {
    return lix(delegateKeys(payer, [m(owner), m(a.config)], pda.ledger(owner)), L("delegate_ledger").done());
  },

  // ------------------------------------------------------------- payouts (L1)
  finalizeWithdraw(a: Addrs, rescuer: PublicKey, owner: PublicKey, n: bigint) {
    return lix([m(rescuer, true, true), m(a.config), m(pda.ledger(owner)), m(owner), m(pda.withdraw(owner, n), true), m(ata(owner, a.mint), true),
      m(a.mint), m(a.vault, true), m(a.vaultAuth), m(TOKEN_PROGRAM_ID), m(ATA_PROGRAM_ID), m(SYSTEM_PROGRAM_ID)],
      L("finalize_withdraw").pk(owner).u64(n).done());
  },

  // ------------------------------------------------------------- ER
  setSession(owner: PublicKey, signer: PublicKey, cap: bigint, expiresTs: bigint) {
    return lix([m(owner, false, true), m(pda.ledger(owner), true)], L("set_session").pk(signer).u64(cap).i64(expiresTs).done());
  },
  ingestDeposit(owner: PublicKey, n: bigint) {
    return lix([m(pda.ledger(owner), true), m(pda.deposit(owner, n))], L("ingest_deposit").u64(n).done());
  },
  requestWithdraw(a: Addrs, authority: PublicKey, owner: PublicKey, amount: bigint, injectFault = false, sessionToken?: PublicKey | null) {
    return lix([m(authority, false, true), m(pda.ledger(owner), true), m(a.config), optional(sessionToken), m(a.escrowAuth, true),
      m(a.feeVault, true), m(LANDED_PROGRAM_ID), m(MAGIC_PROGRAM_ID), m(MAGIC_CONTEXT_ID, true)],
      L("request_withdraw").u64(amount).bool(injectFault).done());
  },
  requestCommit(a: Addrs, owner: PublicKey) {
    return lix([m(pda.ledger(owner), true), m(a.config), m(a.escrowAuth, true), m(a.feeVault, true), m(MAGIC_PROGRAM_ID), m(MAGIC_CONTEXT_ID, true)],
      L("request_commit").done());
  },
  ackWithdrawal(owner: PublicKey, n: bigint) {
    return lix([m(pda.ledger(owner), true), m(pda.withdraw(owner, n))], L("ack_withdrawal").u64(n).done());
  },
  enterRound(a: Addrs, authority: PublicKey, owner: PublicKey, amount: bigint, sessionToken?: PublicKey | null) {
    return lix([m(authority, false, true), m(pda.ledger(owner), true), m(a.table, true), m(a.config), optional(sessionToken)],
      L("enter_round").u64(amount).done());
  },
  leaveSolo(a: Addrs, authority: PublicKey, owner: PublicKey, sessionToken?: PublicKey | null) {
    return lix([m(authority, false, true), m(pda.ledger(owner), true), m(a.table, true), optional(sessionToken)], L("leave_solo").done());
  },
  closeRound(a: Addrs, callerKind: number = CLOSED_BY.KEEPER, queue = VRF_EPHEMERAL_QUEUE) {
    return lix([m(a.table, true), m(queue, true), m(INSTRUCTIONS_SYSVAR), m(pda.vrfIdentity()), m(VRF_PROGRAM_ID), m(SLOT_HASHES_SYSVAR), m(SYSTEM_PROGRAM_ID)],
      L("close_round").u8(callerKind).done());
  },
  retryVrf(a: Addrs, queue = VRF_EPHEMERAL_QUEUE) {
    return lix([m(a.table, true), m(queue, true), m(pda.vrfIdentity()), m(VRF_PROGRAM_ID), m(SLOT_HASHES_SYSVAR), m(SYSTEM_PROGRAM_ID)], L("retry_vrf").done());
  },
  settleRound(a: Addrs, roundId: bigint, winnerOwner: PublicKey) {
    return lix([m(a.table, true), m(pda.ledger(winnerOwner), true), m(a.treasuryLedger, true), m(a.config), m(a.escrowAuth, true),
      m(a.feeVault, true), m(MAGIC_PROGRAM_ID), m(MAGIC_CONTEXT_ID, true)], L("settle_round").u64(roundId).done());
  },
  voidRound(a: Addrs, roundId: bigint, entrantOwners: PublicKey[]) {
    return lix([m(a.table, true), ...entrantOwners.map((o) => m(pda.ledger(o), true))], L("void_round").u64(roundId).done());
  },
  scheduleCrank(a: Addrs, admin: PublicKey, queue = VRF_EPHEMERAL_QUEUE) {
    return lix([m(admin, true, true), m(a.config), m(a.table, true), m(queue, true), m(INSTRUCTIONS_SYSVAR), m(LANDED_PROGRAM_ID), m(MAGIC_PROGRAM_ID),
      m(pda.vrfIdentity()), m(VRF_PROGRAM_ID), m(SLOT_HASHES_SYSVAR), m(SYSTEM_PROGRAM_ID)], L("schedule_crank").done());
  },
  computeUnitLimit(units: number) {
    const data = Buffer.alloc(5);
    data[0] = 2;
    data.writeUInt32LE(units, 1);
    return new TransactionInstruction({ programId: COMPUTE_BUDGET_ID, keys: [], data });
  },

  // ------------------------------------------------------------- MagicBlock session keys (L1)
  /** `create_session_v2(top_up, valid_until, lamports)` on the session-keys program (SessionTokenV2). */
  createSessionV2(authority: PublicKey, sessionSigner: PublicKey, feePayer: PublicKey, validUntil: bigint, topUpLamports?: bigint) {
    const disc = Array.from(sha256(new TextEncoder().encode("global:create_session_v2")).slice(0, 8));
    const data = new W().disc(disc).opt(topUpLamports !== undefined ? true : null, (w, v) => w.bool(v))
      .opt(validUntil, (w, v) => w.i64(v)).opt(topUpLamports ?? null, (w, v) => w.u64(v)).done();
    const token = sessionTokenV2(LANDED_PROGRAM_ID, sessionSigner, authority, SESSION_KEYS_PROGRAM_ID);
    return {
      token,
      ix: new TransactionInstruction({
        programId: SESSION_KEYS_PROGRAM_ID,
        keys: [m(token, true), m(sessionSigner, true, true), m(feePayer, true, true), m(authority, false, true), m(LANDED_PROGRAM_ID), m(SYSTEM_PROGRAM_ID)],
        data,
      }),
    };
  },
};

// ------------------------------------------------------------- naive baseline
export const naiveIx = {
  initialize(admin: PublicKey, mint: PublicKey, erValidator: PublicKey) {
    return nix([m(admin, true, true), m(naivePda.config(), true), m(mint), m(naivePda.vault(), true), m(naivePda.vaultAuth()), m(TOKEN_PROGRAM_ID), m(SYSTEM_PROGRAM_ID)],
      N("initialize").pk(erValidator).done());
  },
  fund(owner: PublicKey, mint: PublicKey, amount: bigint) {
    return nix([m(owner, true, true), m(naivePda.config()), m(naivePda.ledger(owner), true), m(mint), m(ata(owner, mint), true), m(naivePda.vault(), true),
      m(TOKEN_PROGRAM_ID), m(ATA_PROGRAM_ID), m(SYSTEM_PROGRAM_ID)], N("fund").u64(amount).done());
  },
  delegateLedger(owner: PublicKey) {
    const l = naivePda.ledger(owner);
    return nix([m(owner, true, true), m(naivePda.config()), m(dlpPda.buffer(l, NAIVE_PROGRAM_ID), true), m(dlpPda.record(l), true),
      m(dlpPda.metadata(l), true), m(l, true), m(NAIVE_PROGRAM_ID), m(DELEGATION_PROGRAM_ID), m(SYSTEM_PROGRAM_ID)], N("delegate_ledger").done());
  },
  cashOut(owner: PublicKey, amount: bigint, injectFault: boolean) {
    return nix([m(owner, true, true), m(naivePda.ledger(owner), true), m(naivePda.config()), m(NAIVE_PROGRAM_ID), m(MAGIC_PROGRAM_ID), m(MAGIC_CONTEXT_ID, true)],
      N("cash_out").u64(amount).bool(injectFault).done());
  },
};
