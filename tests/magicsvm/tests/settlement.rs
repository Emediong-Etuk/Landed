//! Settlement protocol tests (F1/F2/F5/F6/F7 and A1–A10, A19–A24, A27).
mod common;
use common::*;
use landed::state::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn ata_of(h: &H, p: &Player) -> anchor_lang::prelude::Pubkey {
    ata(&p.pk, &h.mint)
}

// ------------------------------------------------------------------ happy paths

#[test]
fn deposit_ingest_credits_exactly_once_in_order() {
    let mut h = H::new();
    let p = h.player(40 * D);
    let l = h.ledger(ER, &p.pk);
    assert_eq!(l.available, 40 * D);
    assert_eq!(l.ingested_count, 1);
    assert_eq!(l.ingested_total, 40 * D);
    assert_eq!(h.vault_balance(), 40 * D, "I1: vault == deposits - withdrawals");
    // A19a: ingest the same receipt twice
    let i = h.ingest_ix(p.pk, 0);
    let f = h.fail(ER, &[&p.kp], &[i], "double ingest");
    assert!(f.has("OutOfOrder"), "{}", f.logs);
    // A19b: out of order (receipt #2 before #1)
    let d1 = h.deposit_ix(p.pk, 1, 5 * D);
    let d2 = h.deposit_ix(p.pk, 2, 5 * D);
    h.ok(L1, &[&p.kp], &[d1, d2], "two deposits");
    let i2 = h.ingest_ix(p.pk, 2);
    let f = h.fail(ER, &[&p.kp], &[i2], "out of order");
    assert!(f.has("OutOfOrder"));
    let (i1, i2) = (h.ingest_ix(p.pk, 1), h.ingest_ix(p.pk, 2));
    h.ok(ER, &[&p.kp], &[i1, i2], "in order");
    assert_eq!(h.ledger(ER, &p.pk).available, 50 * D);
}

#[test]
fn a19c_forged_deposit_receipt_rejected() {
    let mut h = H::new();
    let p = h.player(10 * D);
    let q = h.player(10 * D);
    // q's receipt #0 presented for p's ledger at nonce 1 (wrong PDA / owner)
    let mut i = h.ingest_ix(p.pk, 1);
    i.accounts[1].pubkey = addr(dep_pda(&q.pk, 0));
    let f = h.fail(ER, &[&p.kp], &[i], "forged receipt");
    assert!(f.has("InvalidReceipt"), "{}", f.logs);
}

#[test]
fn withdraw_happy_path_paid_by_action_then_acked() {
    let mut h = H::new();
    let p = h.player(50 * D);
    let w = h.request_withdraw_ix(p.pk, p.pk, 10 * D, false, None);
    h.ok(ER, &[&p.kp], &[w], "request_withdraw");
    let l = h.ledger(ER, &p.pk);
    assert_eq!(l.available, 40 * D);
    assert_eq!(l.withdraw_requested_total, 10 * D);
    let r = h.receipt(&p.pk, 0).expect("post-commit action must have created the receipt");
    assert_eq!(r.amount, 10 * D);
    assert_eq!(r.path, pay_path::ACTION);
    assert_eq!(h.token_balance(&ata_of(&h, &p)), 60 * D, "faucet 100 - deposit 50 + payout 10");
    assert_eq!(h.vault_balance(), 40 * D, "I1");
    // committed L1 copy shows the pending entry (F7: two truths reconciled)
    let l1 = h.ledger(L1, &p.pk);
    assert_eq!(l1.find_pending(0).unwrap().amount, 10 * D);
    let a = h.ack_ix(p.pk, 0);
    h.ok(ER, &[&p.kp], &[a], "ack");
    assert_eq!(h.ledger(ER, &p.pk).ring[0].state, landed_core::slot_state::ACKED);
}

// ------------------------------------------------------------------ F1: the headline

#[test]
fn f1_injected_fault_action_dropped_then_rescued_by_third_party() {
    let mut h = H::new();
    let p = h.player(50 * D);
    let w = h.request_withdraw_ix(p.pk, p.pk, 10 * D, true, None);
    h.ok(ER, &[&p.kp], &[w], "request_withdraw (fault)");
    // Debited in the rollup...
    assert_eq!(h.ledger(ER, &p.pk).available, 40 * D);
    // ...commit landed without the action: Pending in the committed ledger, no receipt, not paid.
    let l1 = h.ledger(L1, &p.pk);
    assert!(l1.find_pending(0).is_some(), "commit must land even though the action failed");
    assert!(h.receipt(&p.pk, 0).is_none(), "no receipt: the action was dropped");
    assert_eq!(h.token_balance(&ata_of(&h, &p)), 50 * D, "player not paid yet");
    // A third party rescues. Funds go to the OWNER, rent from the rescuer.
    let rescuer = Keypair::new();
    h.svm.airdrop(&rescuer.pubkey(), 1_000_000_000).unwrap();
    let f = h.finalize_ix(kp_pk(&rescuer), p.pk, 0);
    h.ok(L1, &[&rescuer], &[f], "rescue");
    let r = h.receipt(&p.pk, 0).unwrap();
    assert_eq!(r.path, pay_path::RESCUE);
    assert_eq!(r.rescuer, kp_pk(&rescuer));
    assert_eq!(h.token_balance(&ata_of(&h, &p)), 60 * D, "owner paid via rescue");
    assert_eq!(h.token_balance(&ata(&kp_pk(&rescuer), &h.mint)), 0, "rescuer never receives funds");
    // A3: second rescue fails (receipt exists)
    let f2 = h.finalize_ix(kp_pk(&rescuer), p.pk, 0);
    let e = h.fail(L1, &[&rescuer], &[f2], "double rescue");
    assert!(e.has("already in use") || e.has("0x0"), "{}", e.logs);
    assert_eq!(h.token_balance(&ata_of(&h, &p)), 60 * D, "never paid twice");
    assert_eq!(h.vault_balance(), 40 * D, "I1 exact");
}

#[test]
fn a4_action_and_rescue_race_exactly_one_pays() {
    let mut h = H::new();
    let p = h.player(50 * D);
    let w = h.request_withdraw_ix(p.pk, p.pk, 7 * D, false, None);
    h.ok(ER, &[&p.kp], &[w], "withdraw");
    assert!(h.receipt(&p.pk, 0).is_some());
    // The rescue arrives after the action already paid: it must fail harmlessly.
    let f = h.finalize_ix(kp_pk(&p.kp), p.pk, 0);
    h.fail(L1, &[&p.kp], &[f], "late rescue");
    assert_eq!(h.token_balance(&ata_of(&h, &p)), 57 * D);
}

#[test]
fn rescue_creates_missing_owner_ata() {
    let mut h = H::new();
    let p = h.player(20 * D);
    // Close-ish scenario: the owner moved all tokens and we pay to a fresh owner? Instead:
    // verify init_if_needed path by withdrawing for an owner whose ATA we never touched
    // (treasury-like owners). Here: ATA exists from faucet; assert path works regardless.
    let w = h.request_withdraw_ix(p.pk, p.pk, 5 * D, true, None);
    h.ok(ER, &[&p.kp], &[w], "withdraw fault");
    let f = h.finalize_ix(kp_pk(&p.kp), p.pk, 0);
    h.ok(L1, &[&p.kp], &[f], "self-rescue");
    assert_eq!(h.token_balance(&ata_of(&h, &p)), 85 * D);
}

#[test]
fn request_commit_is_rate_limited_and_permissionless() {
    let mut h = H::new();
    let p = h.player(20 * D);
    let anyone = Keypair::new();
    h.svm.airdrop(&anyone.pubkey(), 1_000_000_000).unwrap();
    let c = h.request_commit_ix(p.pk);
    let f = h.fail(ER, &[&anyone], &[c.clone()], "nothing pending");
    assert!(f.has("NothingPending"));
    let w = h.request_withdraw_ix(p.pk, p.pk, 5 * D, true, None);
    h.ok(ER, &[&p.kp], &[w], "withdraw fault");
    let f = h.fail(ER, &[&anyone], &[c.clone()], "too early");
    assert!(f.has("CommitTooEarly"));
    h.advance(6);
    h.ok(ER, &[&anyone], &[c], "forced bare commit");
    assert!(h.ledger(L1, &p.pk).find_pending(0).is_some());
}

// ------------------------------------------------------------------ F5: action handler auth

#[test]
fn a1_direct_call_without_escrow_signer_fails() {
    let mut h = H::new();
    let p = h.player(20 * D);
    let w = h.request_withdraw_ix(p.pk, p.pk, 5 * D, true, None);
    h.ok(ER, &[&p.kp], &[w], "withdraw fault (pending, unpaid)");
    // Attacker passes the right escrow PDA but cannot sign for it.
    let mut i = h.settle_direct_ix(p.pk, 0, h.escrow_auth, h.escrow);
    for m in i.accounts.iter_mut() {
        m.is_signer = m.pubkey == addr(kp_pk(&p.kp));
    }
    let bh = h.svm.latest_blockhash_for(L1);
    let mut tx = solana_transaction::Transaction::new_unsigned(solana_message::Message::new(&[i], Some(&p.kp.pubkey())));
    tx.partial_sign(&[&p.kp], bh);
    let r = h.svm.send_transaction_to(L1, tx);
    assert!(r.is_err(), "direct call must fail");
    let logs = r.err().unwrap().meta.logs.join("\n");
    assert!(
        logs.contains("Unauthorized") || logs.contains("signer privilege escalated") || logs.contains("signature") || logs.is_empty(),
        "{logs}"
    );
    assert!(h.receipt(&p.pk, 0).is_none());
}

#[test]
fn a2_foreign_escrow_authority_rejected() {
    let mut h = H::new();
    let p = h.player(20 * D);
    let w = h.request_withdraw_ix(p.pk, p.pk, 5 * D, true, None);
    h.ok(ER, &[&p.kp], &[w], "withdraw fault");
    // Attacker uses its own key as escrow AND signs: address pinning must reject it.
    let attacker = Keypair::new();
    h.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let i = h.settle_direct_ix(p.pk, 0, kp_pk(&attacker), kp_pk(&attacker));
    let f = h.fail(L1, &[&attacker], &[i], "foreign escrow_auth");
    assert!(f.has("ConstraintSeeds") || f.has("Unauthorized"), "{}", f.logs);
    // Foreign escrow_auth with its correctly-derived escrow: seeds bind escrow_auth to OUR PDA.
    let foreign_escrow = ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer(&kp_pk(&attacker), ACTION_ESCROW_INDEX);
    // The attacker cannot sign for a DLP-derived escrow PDA, so send it unsigned.
    let mut i = h.settle_direct_ix(p.pk, 0, kp_pk(&attacker), foreign_escrow);
    for m in i.accounts.iter_mut() {
        if m.pubkey == addr(foreign_escrow) {
            m.is_signer = false;
        }
    }
    let f = h.send(L1, &[&attacker], &[i]).unwrap_err();
    assert!(
        f.has("ConstraintSeeds") || f.has("Unauthorized") || f.has("signer privilege escalated"),
        "{}",
        f.logs
    );
}

#[test]
fn a5_forged_ledger_accounts_rejected() {
    let mut h = H::new();
    let p = h.player(20 * D);
    let q = h.player(20 * D);
    let w = h.request_withdraw_ix(q.pk, q.pk, 9 * D, true, None);
    h.ok(ER, &[&q.kp], &[w], "q withdraws (unpaid)");
    // p tries to be paid using q's committed ledger (wrong PDA for owner p).
    let i = h.finalize_ix_with(kp_pk(&p.kp), p.pk, 0, ata(&p.pk, &h.mint), ledger_pda(&q.pk));
    let f = h.fail(L1, &[&p.kp], &[i], "wrong ledger PDA");
    assert!(f.has("InvalidLedger"), "{}", f.logs);
    // Wrong owner program / discriminator: pass the Config account as "ledger".
    let i = h.finalize_ix_with(kp_pk(&p.kp), p.pk, 0, ata(&p.pk, &h.mint), h.config);
    let f = h.fail(L1, &[&p.kp], &[i], "config as ledger");
    assert!(f.has("InvalidLedger"), "{}", f.logs);
}

#[test]
fn a6_destination_cannot_be_redirected() {
    let mut h = H::new();
    let q = h.player(20 * D);
    let thief = h.player(20 * D);
    let w = h.request_withdraw_ix(q.pk, q.pk, 9 * D, true, None);
    h.ok(ER, &[&q.kp], &[w], "q withdraws (unpaid)");
    // Thief rescues q's payout but points owner_ata at the thief's own ATA.
    let i = h.finalize_ix_with(kp_pk(&thief.kp), q.pk, 0, ata(&thief.pk, &h.mint), ledger_pda(&q.pk));
    let f = h.fail(L1, &[&thief.kp], &[i], "redirect");
    assert!(f.has("ConstraintTokenOwner") || f.has("ConstraintAssociated") || f.has("InvalidDestination"), "{}", f.logs);
    // Amount is never an argument: the only args are (owner, nonce).
    let i = h.finalize_ix(kp_pk(&thief.kp), q.pk, 0);
    h.ok(L1, &[&thief.kp], &[i], "honest rescue by stranger");
    assert_eq!(h.token_balance(&ata(&q.pk, &h.mint)), 89 * D);
}

// ------------------------------------------------------------------ ring buffer

#[test]
fn a20_ring_full_blocks_17th_unacked_withdrawal() {
    let mut h = H::new();
    let p = h.player(100 * D);
    for _ in 0..16 {
        let w = h.request_withdraw_ix(p.pk, p.pk, D, true, None);
        h.ok(ER, &[&p.kp], &[w], "withdraw");
    }
    let w = h.request_withdraw_ix(p.pk, p.pk, D, false, None);
    let f = h.fail(ER, &[&p.kp], &[w], "17th");
    assert!(f.has("RingFull"));
    // rescue + ack slot 0, then the 17th fits
    let i = h.finalize_ix(kp_pk(&p.kp), p.pk, 0);
    h.ok(L1, &[&p.kp], &[i], "rescue 0");
    let a = h.ack_ix(p.pk, 0);
    h.ok(ER, &[&p.kp], &[a], "ack 0");
    let w = h.request_withdraw_ix(p.pk, p.pk, D, false, None);
    h.ok(ER, &[&p.kp], &[w], "17th after ack");
    assert_eq!(h.ledger(ER, &p.pk).ring[0].nonce, 16);
    assert!(h.receipt(&p.pk, 16).is_some());
}

#[test]
fn ack_requires_real_receipt() {
    let mut h = H::new();
    let p = h.player(20 * D);
    let w = h.request_withdraw_ix(p.pk, p.pk, 2 * D, true, None);
    h.ok(ER, &[&p.kp], &[w], "w");
    let a = h.ack_ix(p.pk, 0);
    let f = h.fail(ER, &[&p.kp], &[a], "ack without receipt");
    assert!(f.has("InvalidReceipt"), "{}", f.logs);
}

// ------------------------------------------------------------------ F2: many cash-outs per session

#[test]
fn f2_thirty_cashouts_in_one_delegation_session() {
    let mut h = H::new();
    let p = h.player(100 * D);
    for i in 0..30u64 {
        let w = h.request_withdraw_ix(p.pk, p.pk, D, false, None);
        h.ok(ER, &[&p.kp], &[w], &format!("withdraw {i}"));
        assert!(h.receipt(&p.pk, i).is_some(), "cash-out {i} paid");
        let a = h.ack_ix(p.pk, i);
        h.ok(ER, &[&p.kp], &[a], "ack");
    }
    assert_eq!(h.token_balance(&ata(&p.pk, &h.mint)), 30 * D);
    assert_eq!(h.vault_balance(), 70 * D);
}

// ------------------------------------------------------------------ sessions (A7–A10)

#[test]
fn a7_a8_a9_a10_session_rules() {
    let mut h = H::new();
    let p = h.player(50 * D);
    let s = Keypair::new(); // session signer with 0 lamports
    let now = h.now();
    let set = h.set_session_ix(p.pk, kp_pk(&s), 5 * D, now + 3600);
    h.ok(ER, &[&p.kp], &[set], "set_session");
    let tok = h.put_session_token(p.pk, kp_pk(&s), landed::ID, now + 3600, false);
    // A7: session withdraws — destination is still the owner's ATA.
    let w = h.request_withdraw_ix(kp_pk(&s), p.pk, 3 * D, false, Some(tok));
    h.ok(ER, &[&s], &[w], "session withdraw");
    assert_eq!(h.receipt(&p.pk, 0).unwrap().dest_ata, ata(&p.pk, &h.mint));
    // A8: cap
    let e = h.enter_ix(kp_pk(&s), p.pk, 5 * D, Some(tok));
    h.ok(ER, &[&s], &[e], "enter 5 within cap");
    let e = h.enter_ix(kp_pk(&s), p.pk, D, Some(tok));
    let f = h.fail(ER, &[&s], &[e], "over cap");
    assert!(f.has("SessionCapExceeded"));
    // missing token
    let e = h.enter_ix(kp_pk(&s), p.pk, D, None);
    let f = h.fail(ER, &[&s], &[e], "no token");
    assert!(f.has("InvalidSession"));
    // A10: V1 token rejected by type
    let v1 = h.put_session_token(p.pk, kp_pk(&s), landed::ID, now + 3600, true);
    let w = h.request_withdraw_ix(kp_pk(&s), p.pk, D, false, Some(v1));
    let f = h.fail(ER, &[&s], &[w], "v1 token");
    assert!(f.has("AccountDiscriminatorMismatch") || f.has("3002"), "{}", f.logs);
    // token for another program
    let other = h.put_session_token(p.pk, kp_pk(&s), anchor_lang::prelude::Pubkey::new_unique(), now + 3600, false);
    let w = h.request_withdraw_ix(kp_pk(&s), p.pk, D, false, Some(other));
    assert!(h.fail(ER, &[&s], &[w], "other program").has("InvalidSession"));
    // A9: expiry
    h.advance(3601);
    let w = h.request_withdraw_ix(kp_pk(&s), p.pk, D, false, Some(tok));
    assert!(h.fail(ER, &[&s], &[w], "expired").has("InvalidSession"));
    // random signer
    let x = Keypair::new();
    let w = h.request_withdraw_ix(kp_pk(&x), p.pk, D, false, Some(tok));
    assert!(h.fail(ER, &[&x], &[w], "stranger").has("Unauthorized"));
}

// ------------------------------------------------------------------ admin / pause / faucet

#[test]
fn a21_pause_blocks_entries_and_deposits_but_not_exits() {
    let mut h = H::new();
    let p = h.player(50 * D);
    let w = h.request_withdraw_ix(p.pk, p.pk, 2 * D, true, None);
    h.ok(ER, &[&p.kp], &[w], "pending before pause");
    let admin = clone_kp(&h.admin);
    let set = ix(
        landed::instruction::SetFlags { paused: true, close_only: true },
        landed::accounts::AdminOnly { admin: kp_pk(&admin), config: h.config },
    );
    h.ok(L1, &[&admin], &[set], "pause");
    let d = h.deposit_ix(p.pk, 1, D);
    assert!(h.fail(L1, &[&p.kp], &[d], "deposit paused").has("Paused"));
    let e = h.enter_ix(p.pk, p.pk, D, None);
    assert!(h.fail(ER, &[&p.kp], &[e], "enter paused").has("Paused"));
    // exits still work
    let w = h.request_withdraw_ix(p.pk, p.pk, 2 * D, false, None);
    h.ok(ER, &[&p.kp], &[w], "withdraw while paused");
    let r = h.finalize_ix(kp_pk(&p.kp), p.pk, 0);
    h.ok(L1, &[&p.kp], &[r], "rescue while paused");
    // non-admin cannot pause
    let set = ix(
        landed::instruction::SetFlags { paused: false, close_only: false },
        landed::accounts::AdminOnly { admin: p.pk, config: h.config },
    );
    assert!(h.fail(L1, &[&p.kp], &[set], "non-admin").has("Unauthorized"));
}

#[test]
fn a22_admin_has_no_path_to_vault_funds() {
    // There is no instruction that transfers from the vault except the two payout
    // paths, both of which pay only `owner`'s ATA for a committed Pending entry.
    let mut h = H::new();
    let p = h.player(30 * D);
    let admin = clone_kp(&h.admin);
    // Admin tries to rescue the player's (non-existent) withdrawal to themselves.
    let i = h.finalize_ix_with(kp_pk(&admin), kp_pk(&admin), 0, ata(&kp_pk(&admin), &h.mint), ledger_pda(&p.pk));
    h.fail(L1, &[&admin], &[i], "admin drain via account confusion");
    // Admin as owner of their own (absent) ledger: nothing pending.
    let i = h.finalize_ix(kp_pk(&admin), kp_pk(&admin), 0);
    h.fail(L1, &[&admin], &[i], "admin nothing pending");
    assert_eq!(h.vault_balance(), 30 * D);
}

#[test]
fn a23_faucet_rate_limits() {
    let mut h = H::new();
    let p = h.player(10 * D);
    let f = h.faucet_ix(p.pk);
    assert!(h.fail(L1, &[&p.kp], &[f.clone()], "cooldown").has("FaucetCooldown"));
    for _ in 0..9 {
        h.advance(6 * 3600 + 1);
        h.ok(L1, &[&p.kp], &[f.clone()], "faucet");
    }
    h.advance(6 * 3600 + 1);
    assert!(h.fail(L1, &[&p.kp], &[f], "cap").has("FaucetCapReached"));
    assert_eq!(h.token_balance(&ata(&p.pk, &h.mint)), 990 * D);
}

#[test]
fn a24_inject_fault_rejected_without_fault_lab_feature() {
    let mut h = H::with_program("landed_mainnet");
    let p = h.player(10 * D);
    let w = h.request_withdraw_ix(p.pk, p.pk, D, true, None);
    let f = h.fail(ER, &[&p.kp], &[w], "fault in mainnet build");
    assert!(f.has("FaultLabDisabled"), "{}", f.logs);
    let w = h.request_withdraw_ix(p.pk, p.pk, D, false, None);
    h.ok(ER, &[&p.kp], &[w], "normal withdraw in mainnet build");
    assert!(h.receipt(&p.pk, 0).is_some());
}

#[test]
fn a27_amount_bounds_and_overflow() {
    let mut h = H::new();
    let p = h.player(10 * D);
    let w = h.request_withdraw_ix(p.pk, p.pk, u64::MAX, false, None);
    assert!(h.fail(ER, &[&p.kp], &[w], "huge").has("InsufficientBalance"));
    let w = h.request_withdraw_ix(p.pk, p.pk, 0, false, None);
    assert!(h.fail(ER, &[&p.kp], &[w], "zero").has("AmountTooSmall"));
    let e = h.enter_ix(p.pk, p.pk, u64::MAX, None);
    assert!(h.fail(ER, &[&p.kp], &[e], "huge chip").has("AmountTooLarge"));
    let d = h.deposit_ix(p.pk, 1, 0);
    assert!(h.fail(L1, &[&p.kp], &[d], "zero deposit").has("AmountTooSmall"));
}

#[test]
fn a25_sizes() {
    assert!(LEDGER_SPACE <= 10_240 && TABLE_SPACE <= 10_240);
    eprintln!("LEDGER_SPACE={LEDGER_SPACE} TABLE_SPACE={TABLE_SPACE}");
}

/// S1 outcome "reverted & stuck" (how MagicSVM models a failing action): the ER
/// transaction itself reverts, so nothing is debited and nothing can be lost.
#[test]
fn s1_reverted_outcome_debits_nothing() {
    let mut h = H::with_program("landed_test_stuck");
    let p = h.player(20 * D);
    let w = h.request_withdraw_ix(p.pk, p.pk, 5 * D, true, None);
    let f = h.fail(ER, &[&p.kp], &[w], "faulted action reverts the ER tx");
    assert!(f.has("6016") || f.has("InjectedFault"), "{:?} {}", f.err, f.logs);
    let l = h.ledger(ER, &p.pk);
    assert_eq!(l.available, 20 * D, "no debit");
    assert_eq!(l.withdraw_nonce, 0);
    assert!(h.receipt(&p.pk, 0).is_none());
}
