import { PublicKey } from "@solana/web3.js";
import {
  ACTION_ESCROW_INDEX,
  ATA_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  LANDED_PROGRAM_ID,
  NAIVE_PROGRAM_ID,
  SEEDS,
  TOKEN_PROGRAM_ID,
  VRF_PROGRAM_ID,
} from "./constants";

const enc = (s: string) => new TextEncoder().encode(s);
export const u64le = (n: bigint | number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};

const find = (seeds: Uint8Array[], program = LANDED_PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const pda = {
  config: () => find([enc(SEEDS.config)]),
  mint: () => find([enc(SEEDS.mint)]),
  mintAuth: () => find([enc(SEEDS.mintAuth)]),
  vault: () => find([enc(SEEDS.vault)]),
  vaultAuth: () => find([enc(SEEDS.vaultAuth)]),
  escrowAuth: () => find([enc(SEEDS.escrowAuth)]),
  treasury: () => find([enc(SEEDS.treasury)]),
  user: (owner: PublicKey) => find([enc(SEEDS.user), owner.toBytes()]),
  ledger: (owner: PublicKey) => find([enc(SEEDS.ledger), owner.toBytes()]),
  deposit: (owner: PublicKey, n: bigint | number) => find([enc(SEEDS.deposit), owner.toBytes(), u64le(n)]),
  withdraw: (owner: PublicKey, n: bigint | number) => find([enc(SEEDS.withdraw), owner.toBytes(), u64le(n)]),
  table: (id: bigint | number) => find([enc(SEEDS.table), u64le(id)]),
  vrfIdentity: () => find([enc(SEEDS.identity)]),
  /** Scoped VRF identity that signs our callbacks: PDA(["identity", program], VRF). */
  vrfCallbackIdentity: () => PublicKey.findProgramAddressSync([enc(SEEDS.identity), LANDED_PROGRAM_ID.toBytes()], VRF_PROGRAM_ID)[0],
  treasuryLedger: () => find([enc(SEEDS.ledger), find([enc(SEEDS.treasury)]).toBytes()]),
};

export const naivePda = {
  config: () => find([enc("nconfig")], NAIVE_PROGRAM_ID),
  vault: () => find([enc("nvault")], NAIVE_PROGRAM_ID),
  vaultAuth: () => find([enc("nvault_auth")], NAIVE_PROGRAM_ID),
  ledger: (owner: PublicKey) => find([enc("nledger"), owner.toBytes()], NAIVE_PROGRAM_ID),
};

export const dlpPda = {
  buffer: (account: PublicKey, ownerProgram: PublicKey) => find([enc("buffer"), account.toBytes()], ownerProgram),
  record: (account: PublicKey) => find([enc("delegation"), account.toBytes()], DELEGATION_PROGRAM_ID),
  metadata: (account: PublicKey) => find([enc("delegation-metadata"), account.toBytes()], DELEGATION_PROGRAM_ID),
  ephemeralBalance: (authority: PublicKey, index = ACTION_ESCROW_INDEX) =>
    find([enc("balance"), authority.toBytes(), new Uint8Array([index])], DELEGATION_PROGRAM_ID),
  magicFeeVault: (validator: PublicKey) => find([enc("magic-fee-vault"), validator.toBytes()], DELEGATION_PROGRAM_ID),
};

export const ata = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()], ATA_PROGRAM_ID)[0];

export const sessionTokenV2 = (target: PublicKey, sessionSigner: PublicKey, authority: PublicKey, sessionProgram: PublicKey) =>
  PublicKey.findProgramAddressSync([enc("session_token_v2"), target.toBytes(), sessionSigner.toBytes(), authority.toBytes()], sessionProgram)[0];
