//! # landed-core
//!
//! Pure, dependency-light logic shared by the `landed` on-chain program, the
//! property tests and the TypeScript verifier (through golden vectors).
//!
//! Nothing in here knows about Solana. Every function is deterministic and
//! total (returns `Option`/`Result` instead of panicking) so it is safe to call
//! from a BPF program with `overflow-checks = true`.

#![no_std]

use sha2::{Digest, Sha256};

/// Basis-point denominator.
pub const BPS_DENOM: u64 = 10_000;
/// Number of pending-withdrawal slots per ledger (fixed so the account size is bounded, F6).
pub const RING_SIZE: usize = 16;
/// Maximum distinct players in one round.
pub const MAX_ENTRIES: usize = 32;
/// Rounds of history kept on the table.
pub const HISTORY_SIZE: usize = 16;
/// Largest account the ER will commit/undelegate (MagicBlock runtime limit).
pub const MAX_COMMIT_BYTES: usize = 10_240;

/// Ring slot states.
pub mod slot_state {
    pub const EMPTY: u8 = 0;
    pub const PENDING: u8 = 1;
    pub const ACKED: u8 = 2;
}

/// House fee, floored: `floor(pot * bps / 10_000)`. `None` if `bps > 10_000`.
pub fn house_fee(pot: u64, bps: u16) -> Option<u64> {
    if bps as u64 > BPS_DENOM {
        return None;
    }
    let fee = (pot as u128) * (bps as u128) / (BPS_DENOM as u128);
    Some(fee as u64) // fee <= pot, always fits
}

/// `(winner_credit, fee)` for a pot. `winner_credit + fee == pot` always.
pub fn split_pot(pot: u64, bps: u16) -> Option<(u64, u64)> {
    let fee = house_fee(pot, bps)?;
    Some((pot - fee, fee))
}

/// The draw target in `[0, pot)` derived from VRF randomness.
///
/// `r = u128::from_le_bytes(randomness[0..16])`, `target = r % pot`.
/// The modulo bias is at most `pot / 2^128`, i.e. < 1e-19 for any u64 pot.
pub fn draw_target(randomness: &[u8; 32], pot: u64) -> Option<u64> {
    if pot == 0 {
        return None;
    }
    let mut lo = [0u8; 16];
    lo.copy_from_slice(&randomness[0..16]);
    let r = u128::from_le_bytes(lo);
    Some((r % pot as u128) as u64)
}

/// Stake-weighted winner selection.
///
/// Walks the cumulative sums of `amounts`; the winner is the first index whose
/// cumulative sum is strictly greater than `draw_target(randomness, Σ amounts)`.
/// Returns `None` for an empty / zero pot or if the sum overflows u64.
pub fn select_winner(randomness: &[u8; 32], amounts: &[u64]) -> Option<usize> {
    let mut pot: u64 = 0;
    for a in amounts {
        pot = pot.checked_add(*a)?;
    }
    let target = draw_target(randomness, pot)?;
    let mut cum: u64 = 0;
    for (i, a) in amounts.iter().enumerate() {
        cum = cum.checked_add(*a)?;
        if cum > target {
            return Some(i);
        }
    }
    None // unreachable when pot > 0
}

/// Hash of the locked entry list: `sha256(u32_le(count) ‖ (player ‖ u64_le(amount))*)`.
pub fn entries_hash(players: &[[u8; 32]], amounts: &[u64]) -> [u8; 32] {
    let n = core::cmp::min(players.len(), amounts.len());
    let mut h = Sha256::new();
    h.update((n as u32).to_le_bytes());
    for i in 0..n {
        h.update(players[i]);
        h.update(amounts[i].to_le_bytes());
    }
    h.finalize().into()
}

/// VRF caller seed. Entries are locked at close, so no player can grind it.
/// `sha256("landed-vrf" ‖ table_id ‖ round_id ‖ entries_hash ‖ closes_ts ‖ vrf_nonce)`.
pub fn vrf_caller_seed(
    table_id: u64,
    round_id: u64,
    entries_hash: &[u8; 32],
    closes_ts: i64,
    vrf_nonce: u64,
) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"landed-vrf");
    h.update(table_id.to_le_bytes());
    h.update(round_id.to_le_bytes());
    h.update(entries_hash);
    h.update(closes_ts.to_le_bytes());
    h.update(vrf_nonce.to_le_bytes());
    h.finalize().into()
}

/// Collision-resistant crank task id:
/// `i64::from_le_bytes(sha256("landed-crank" ‖ program_id ‖ table)[0..8]) & i64::MAX`.
pub fn crank_task_id(program_id: &[u8; 32], table: &[u8; 32]) -> i64 {
    let mut h = Sha256::new();
    h.update(b"landed-crank");
    h.update(program_id);
    h.update(table);
    let d: [u8; 32] = h.finalize().into();
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[0..8]);
    i64::from_le_bytes(b) & i64::MAX
}

/// Ring slot index for a withdrawal nonce.
pub const fn ring_slot(nonce: u64) -> usize {
    (nonce % RING_SIZE as u64) as usize
}

/// A slot can take a new withdrawal only if it is empty or its previous
/// withdrawal has been acknowledged as paid (receipt observed). An unpaid
/// withdrawal can never be overwritten.
pub const fn slot_reusable(state: u8) -> bool {
    state == slot_state::EMPTY || state == slot_state::ACKED
}

/// Pure model of the pending-withdrawal ring, used by property tests and as
/// executable documentation of the on-chain rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Slot {
    pub nonce: u64,
    pub amount: u64,
    pub state: u8,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RingError {
    RingFull,
    NotPending,
    WrongNonce,
}

#[derive(Clone, Debug, Default)]
pub struct Ring {
    pub slots: [Slot; RING_SIZE],
    pub next_nonce: u64,
}

impl Ring {
    /// Push a new withdrawal; returns its nonce.
    pub fn push(&mut self, amount: u64) -> Result<u64, RingError> {
        let n = self.next_nonce;
        let i = ring_slot(n);
        if !slot_reusable(self.slots[i].state) {
            return Err(RingError::RingFull);
        }
        self.slots[i] = Slot { nonce: n, amount, state: slot_state::PENDING };
        self.next_nonce += 1;
        Ok(n)
    }
    /// Mark a pending withdrawal as acknowledged (receipt seen on L1).
    pub fn ack(&mut self, nonce: u64) -> Result<(), RingError> {
        let s = &mut self.slots[ring_slot(nonce)];
        if s.nonce != nonce {
            return Err(RingError::WrongNonce);
        }
        if s.state != slot_state::PENDING {
            return Err(RingError::NotPending);
        }
        s.state = slot_state::ACKED;
        Ok(())
    }
    /// Look up a pending entry by nonce (what the L1 payout reads from the committed ledger).
    pub fn pending(&self, nonce: u64) -> Option<Slot> {
        let s = self.slots[ring_slot(nonce)];
        if s.nonce == nonce && s.state == slot_state::PENDING {
            Some(s)
        } else {
            None
        }
    }
}

/// Fraction of the ring (0..1, as numerator/denominator) at which the reveal
/// needle lands: the centre of the unit at `target`. Frontend multiplies by 360°.
pub fn needle_position(randomness: &[u8; 32], pot: u64) -> Option<(u128, u128)> {
    let t = draw_target(randomness, pot)? as u128;
    Some((2 * t + 1, 2 * pot as u128))
}

#[cfg(test)]
mod tests;
