import { PublicKey } from "@solana/web3.js";

/** Program IDs (fixed by `declare_id!`). */
export const LANDED_PROGRAM_ID = new PublicKey("37AZMxLPm9RY8AKQk4s4oMJaovpRorGQfUmMUbTxiqGq");
export const NAIVE_PROGRAM_ID = new PublicKey("BrHd4kAtkATdaJYcv5GtyQ6ebNUneBV2yqe24EPRtxBc");

/** MagicBlock infrastructure (verified on devnet 2026-11-25, see docs/DECISIONS.md). */
export const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
export const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");
export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
export const VRF_EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const VRF_BASE_QUEUE = new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh");
export const HYDRA_EPHEMERAL_ID = new PublicKey("eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf");
export const SESSION_KEYS_PROGRAM_ID = new PublicKey("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
export const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");
export const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");
export const COMPUTE_BUDGET_ID = new PublicKey("ComputeBudget111111111111111111111111111111");

/** devnet-eu ER validator (validator 2.0; `getIdentity` 2026-11-25). */
export const DEVNET_EU_VALIDATOR = new PublicKey("MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e");

export const ENDPOINTS = {
  devnet: {
    l1: "https://api.devnet.solana.com",
    er: "https://devnet-eu.magicblock.app",
    erWs: "wss://devnet-eu.magicblock.app",
    router: "https://devnet-router.magicblock.app",
  },
  localnet: {
    l1: "http://127.0.0.1:8899",
    er: "http://127.0.0.1:7799",
    erWs: "ws://127.0.0.1:7800",
    router: "http://127.0.0.1:7799",
  },
} as const;

export const SEEDS = {
  config: "config",
  mint: "mint",
  mintAuth: "mint_auth",
  vault: "vault",
  vaultAuth: "vault_auth",
  escrowAuth: "escrow_auth",
  treasury: "treasury",
  user: "user",
  ledger: "ledger",
  deposit: "dep",
  withdraw: "wdr",
  table: "table",
  identity: "identity",
} as const;

export const DUSDC_DECIMALS = 6;
export const ONE_DUSDC = 1_000_000n;
export const ACTION_ESCROW_INDEX = 255;
export const RING_SIZE = 16;
export const MAX_ENTRIES = 32;
export const HISTORY_SIZE = 16;
export const HOUSE_FEE_BPS = 200;
export const CHIPS = [1, 5, 10, 25] as const;
export const DEFAULT_TABLE_ID = 1n;

export const TABLE_STATUS = { OPEN: 0, AWAITING_VRF: 1, DRAWN: 2 } as const;
export const CLOSED_BY = { NONE: 0, CRANK: 1, KEEPER: 2, PLAYER: 3 } as const;
export const SLOT_STATE = { EMPTY: 0, PENDING: 1, ACKED: 2 } as const;
export const PAY_PATH = { ACTION: 0, RESCUE: 1 } as const;
export const ROUND_OUTCOME = { SETTLED: 1, VOIDED: 2 } as const;

/** UI timing policy. */
export const RESCUE_AFTER_MS = 8_000;
export const WATCHDOG_GRACE_SECS = 3;
export const OWED_ALERT_SECS = 60;
