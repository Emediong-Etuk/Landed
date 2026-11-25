use anchor_lang::prelude::*;
use landed_core::{HISTORY_SIZE, MAX_COMMIT_BYTES, MAX_ENTRIES, RING_SIZE};

// ---------------------------------------------------------------- seeds
pub const CONFIG_SEED: &[u8] = b"config";
pub const MINT_SEED: &[u8] = b"mint";
pub const MINT_AUTH_SEED: &[u8] = b"mint_auth";
pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_AUTH_SEED: &[u8] = b"vault_auth";
pub const ESCROW_AUTH_SEED: &[u8] = b"escrow_auth";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const USER_SEED: &[u8] = b"user";
pub const LEDGER_SEED: &[u8] = b"ledger";
pub const DEPOSIT_SEED: &[u8] = b"dep";
pub const WITHDRAW_SEED: &[u8] = b"wdr";
pub const TABLE_SEED: &[u8] = b"table";

/// `ActionArgs::new` default escrow index.
pub const ACTION_ESCROW_INDEX: u8 = 255;
pub const DUSDC_DECIMALS: u8 = 6;
pub const ONE_DUSDC: u64 = 1_000_000;

// Faucet (enforced on-chain)
pub const FAUCET_AMOUNT: u64 = 100 * ONE_DUSDC;
pub const FAUCET_COOLDOWN_SECS: i64 = 6 * 60 * 60;
pub const FAUCET_LIFETIME_CAP: u64 = 1_000 * ONE_DUSDC;

/// Minimum age of a pending withdrawal before anyone may force a bare commit.
pub const REQUEST_COMMIT_MIN_AGE_SECS: i64 = 5;
/// Longest session a player can authorize.
pub const MAX_SESSION_SECS: i64 = 24 * 60 * 60;

// ---------------------------------------------------------------- enums (u8 on the wire)
pub mod table_status {
    pub const OPEN: u8 = 0;
    pub const AWAITING_VRF: u8 = 1;
    pub const DRAWN: u8 = 2;
}
pub mod closed_by {
    pub const NONE: u8 = 0;
    pub const CRANK: u8 = 1;
    pub const KEEPER: u8 = 2;
    pub const PLAYER: u8 = 3;
}
pub mod round_outcome {
    pub const SETTLED: u8 = 1;
    pub const VOIDED: u8 = 2;
}
pub mod pay_path {
    pub const ACTION: u8 = 0;
    pub const RESCUE: u8 = 1;
}

// ================================================================ L1 accounts

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub er_validator: Pubkey,
    pub magic_fee_vault: Pubkey,
    pub treasury: Pubkey,
    pub house_fee_bps: u16,
    pub min_chip: u64,
    pub max_chip: u64,
    pub max_per_player_round: u64,
    pub min_withdraw: u64,
    pub round_secs: u32,
    pub vrf_retry_secs: u32,
    pub vrf_void_secs: u32,
    pub paused: bool,
    pub close_only: bool,
    pub fault_lab: bool,
    pub bump: u8,
    pub mint_bump: u8,
    pub mint_auth_bump: u8,
    pub vault_bump: u8,
    pub vault_auth_bump: u8,
    pub escrow_auth_bump: u8,
    pub treasury_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UserMeta {
    pub owner: Pubkey,
    pub deposit_count: u64,
    pub deposit_total: u64,
    pub last_faucet_ts: i64,
    pub faucet_total: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DepositReceipt {
    pub owner: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    pub ts: i64,
    pub slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct WithdrawReceipt {
    pub owner: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    pub dest_ata: Pubkey,
    /// 0 = paid by the post-commit Magic Action, 1 = paid by a permissionless rescue.
    pub path: u8,
    pub rescuer: Pubkey,
    pub ts: i64,
    pub slot: u64,
    pub bump: u8,
}

/// Delegated fee payer + Magic Action escrow authority (`["escrow_auth"]`).
/// Lives in the ER so commits beyond the 10-commit cap go through the
/// `magic_fee_vault` path (F2).
#[account]
#[derive(InitSpace)]
pub struct EscrowAuth {
    pub bump: u8,
}

// ================================================================ ER (delegated) accounts

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug)]
pub struct PendingWithdrawal {
    pub nonce: u64,
    pub amount: u64,
    pub requested_ts: i64,
    /// landed_core::slot_state (0 Empty, 1 Pending, 2 Acked)
    pub state: u8,
    /// Fault-Lab flag: the post-commit action for this withdrawal fails on purpose.
    pub fault: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct SessionGrant {
    pub signer: Pubkey,
    pub expires_ts: i64,
    pub cap: u64,
    pub spent: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct PlayerStats {
    pub rounds: u64,
    pub wins: u64,
    pub wagered: u64,
    pub won: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Ledger {
    pub owner: Pubkey,
    /// Playable balance in the rollup.
    pub available: u64,
    pub ingested_count: u64,
    pub ingested_total: u64,
    pub withdraw_nonce: u64,
    pub withdraw_requested_total: u64,
    /// Lifetime credits from wins and refunds (for reconciliation).
    pub credited_total: u64,
    /// Lifetime debits into pots.
    pub debited_total: u64,
    pub ring: [PendingWithdrawal; RING_SIZE],
    pub session: SessionGrant,
    pub stats: PlayerStats,
    pub bump: u8,
}

/// One player's stake in the current round (zero-copy, 40 bytes).
#[zero_copy]
#[derive(Default, Debug)]
pub struct Entry {
    pub player: Pubkey,
    pub amount: u64,
}

/// Settled/voided round (zero-copy, 144 bytes, no implicit padding).
#[zero_copy]
#[derive(Default, Debug)]
pub struct RoundResult {
    pub round_id: u64,
    pub pot: u64,
    pub fee: u64,
    pub vrf_nonce: u64,
    pub settled_ts: i64,
    pub winner: Pubkey,
    pub randomness: [u8; 32],
    pub entries_hash: [u8; 32],
    /// round_outcome (1 Settled, 2 Voided)
    pub outcome: u8,
    pub winner_idx: u8,
    pub entry_count: u8,
    pub closed_by: u8,
    pub _pad: [u8; 4],
}

/// The Drop table. Zero-copy so the ~4 KB account never lands on the 4 KB BPF stack.
#[account(zero_copy)]
#[derive(Debug)]
pub struct Table {
    pub id: u64,
    pub round_id: u64,
    pub pot: u64,
    pub vrf_nonce: u64,
    pub history_len: u64,
    pub rounds_settled: u64,
    pub rounds_voided: u64,
    pub closes_by_crank: u64,
    pub closes_by_keeper: u64,
    pub stale_callbacks: u64,
    pub vrf_retries: u64,
    pub opened_ts: i64,
    pub closes_ts: i64,
    pub vrf_first_request_ts: i64,
    pub vrf_last_request_ts: i64,
    pub crank_task_id: i64,
    pub last_crank_ts: i64,
    pub treasury: Pubkey,
    pub entries: [Entry; MAX_ENTRIES],
    pub history: [RoundResult; HISTORY_SIZE],
    pub entries_hash: [u8; 32],
    pub randomness: [u8; 32],
    // Snapshot of config at table creation (keeps ER ixs independent of L1 clones).
    pub round_secs: u32,
    pub vrf_retry_secs: u32,
    pub vrf_void_secs: u32,
    pub house_fee_bps: u16,
    /// table_status (0 Open, 1 AwaitingVrf, 2 Drawn)
    pub status: u8,
    pub entry_count: u8,
    pub vrf_attempts: u8,
    pub winner_idx: u8,
    /// closed_by (1 Crank, 2 Keeper, 3 Player)
    pub closed_by: u8,
    pub bump: u8,
    pub _pad: [u8; 4],
}

// F6: anything we delegate must stay committable (≤ 10,240 bytes).
pub const LEDGER_SPACE: usize = 8 + Ledger::INIT_SPACE;
pub const TABLE_SPACE: usize = 8 + core::mem::size_of::<Table>();
pub const ESCROW_AUTH_SPACE: usize = 8 + EscrowAuth::INIT_SPACE;
const _: () = assert!(LEDGER_SPACE <= MAX_COMMIT_BYTES, "Ledger too large to commit");
const _: () = assert!(TABLE_SPACE <= MAX_COMMIT_BYTES, "Table too large to commit");
const _: () = assert!(core::mem::size_of::<Entry>() == 40);
const _: () = assert!(core::mem::size_of::<RoundResult>() == 144);

impl Ledger {
    pub fn find_pending(&self, nonce: u64) -> Option<PendingWithdrawal> {
        let s = self.ring[landed_core::ring_slot(nonce)];
        if s.nonce == nonce && s.state == landed_core::slot_state::PENDING {
            Some(s)
        } else {
            None
        }
    }
}

impl Table {
    pub fn amounts(&self) -> ([u64; MAX_ENTRIES], usize) {
        let mut a = [0u64; MAX_ENTRIES];
        let n = self.entry_count as usize;
        for (i, e) in self.entries.iter().take(n).enumerate() {
            a[i] = e.amount;
        }
        (a, n)
    }
    pub fn players(&self) -> ([[u8; 32]; MAX_ENTRIES], usize) {
        let mut p = [[0u8; 32]; MAX_ENTRIES];
        let n = self.entry_count as usize;
        for (i, e) in self.entries.iter().take(n).enumerate() {
            p[i] = e.player.to_bytes();
        }
        (p, n)
    }
    pub fn compute_entries_hash(&self) -> [u8; 32] {
        let (p, n) = self.players();
        let (a, _) = self.amounts();
        landed_core::entries_hash(&p[..n], &a[..n])
    }
    pub fn push_history(&mut self, r: RoundResult) {
        let i = (self.history_len % HISTORY_SIZE as u64) as usize;
        self.history[i] = r;
        self.history_len += 1;
    }
    pub fn reset_for_next_round(&mut self) {
        self.round_id += 1;
        self.status = table_status::OPEN;
        self.opened_ts = 0;
        self.closes_ts = 0;
        for e in self.entries.iter_mut() {
            *e = Entry::default();
        }
        self.entry_count = 0;
        self.pot = 0;
        self.entries_hash = [0; 32];
        self.vrf_first_request_ts = 0;
        self.vrf_last_request_ts = 0;
        self.vrf_attempts = 0;
        self.randomness = [0; 32];
        self.winner_idx = 0;
        self.closed_by = closed_by::NONE;
    }
}

#[cfg(test)]
mod size_tests {
    use super::*;
    /// A25 / F6: every delegated account must fit the commit limit.
    #[test]
    fn a25_delegated_accounts_fit_commit_limit() {
        assert!(LEDGER_SPACE <= MAX_COMMIT_BYTES, "ledger {}", LEDGER_SPACE);
        assert!(TABLE_SPACE <= MAX_COMMIT_BYTES, "table {}", TABLE_SPACE);
        assert!(ESCROW_AUTH_SPACE <= MAX_COMMIT_BYTES);
        println!("LEDGER_SPACE={} TABLE_SPACE={}", LEDGER_SPACE, TABLE_SPACE);
    }
}
