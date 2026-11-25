use anchor_lang::prelude::*;

#[event]
pub struct Deposited {
    pub owner: Pubkey,
    pub nonce: u64,
    pub amount: u64,
}
#[event]
pub struct DepositIngested {
    pub owner: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    pub available: u64,
}
#[event]
pub struct WithdrawRequested {
    pub owner: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    pub fault: bool,
    pub ts: i64,
}
#[event]
pub struct WithdrawPaid {
    pub owner: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    /// 0 = Action, 1 = Rescue
    pub path: u8,
    pub rescuer: Pubkey,
}
#[event]
pub struct WithdrawAcked {
    pub owner: Pubkey,
    pub nonce: u64,
}
#[event]
pub struct CommitForced {
    pub owner: Pubkey,
    pub oldest_pending_nonce: u64,
}
#[event]
pub struct Entered {
    pub table: u64,
    pub round_id: u64,
    pub player: Pubkey,
    pub amount: u64,
    pub pot: u64,
}
#[event]
pub struct RoundExtended {
    pub table: u64,
    pub round_id: u64,
    pub closes_ts: i64,
}
#[event]
pub struct RoundClosed {
    pub table: u64,
    pub round_id: u64,
    pub vrf_nonce: u64,
    pub closed_by: u8,
    pub entries_hash: [u8; 32],
}
#[event]
pub struct VrfRetried {
    pub table: u64,
    pub round_id: u64,
    pub vrf_nonce: u64,
    pub attempts: u8,
}
#[event]
pub struct StaleCallbackIgnored {
    pub table: u64,
    pub round_id: u64,
    pub vrf_nonce: u64,
    pub expected_round_id: u64,
    pub expected_nonce: u64,
    pub status: u8,
}
#[event]
pub struct RoundDrawn {
    pub table: u64,
    pub round_id: u64,
    pub vrf_nonce: u64,
    pub winner_idx: u8,
    pub randomness: [u8; 32],
}
#[event]
pub struct RoundSettled {
    pub table: u64,
    pub round_id: u64,
    pub winner: Pubkey,
    pub pot: u64,
    pub fee: u64,
    pub credit: u64,
}
#[event]
pub struct RoundVoided {
    pub table: u64,
    pub round_id: u64,
    pub refunded: u64,
}
#[event]
pub struct SoloLeft {
    pub table: u64,
    pub round_id: u64,
    pub player: Pubkey,
    pub amount: u64,
}
