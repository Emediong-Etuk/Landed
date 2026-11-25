//! The Drop: round lifecycle, VRF (V1–V4), crank, and A11–A18, A26.
mod common;
use anchor_lang::prelude::Pubkey;
use common::*;
use landed::state::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// I2 (one snapshot): Σ available + open pot == Σ ingested − Σ withdraw_requested.
fn assert_i2(h: &H, owners: &[Pubkey]) {
    let mut avail: u128 = 0;
    let mut ingested: u128 = 0;
    let mut requested: u128 = 0;
    for o in owners.iter().chain(std::iter::once(&h.treasury)) {
        let l = h.ledger(ER, o);
        avail += l.available as u128;
        ingested += l.ingested_total as u128;
        requested += l.withdraw_requested_total as u128;
    }
    let t = h.table();
    assert_eq!(avail + t.pot as u128, ingested - requested, "I2 zero-sum violated");
}

/// I6: winner == select_winner(randomness, entries) and fee == floor(pot*bps/1e4).
fn assert_i6(r: &RoundResult, players: &[Pubkey], amounts: &[u64]) {
    let w = landed_core::select_winner(&r.randomness, amounts).unwrap();
    assert_eq!(players[w], r.winner, "I6 winner recomputation");
    assert_eq!(r.fee, landed_core::house_fee(r.pot, 200).unwrap(), "I6 fee");
}

#[test]
fn v1_round_request_callback_settle() {
    let mut h = H::new();
    let a = h.player(50 * D);
    let b = h.player(50 * D);
    let ea = h.enter_ix(a.pk, a.pk, 5 * D, None);
    let eb = h.enter_ix(b.pk, b.pk, 10 * D, None);
    h.ok(ER, &[&a.kp], &[ea], "a enters");
    h.ok(ER, &[&b.kp], &[eb], "b enters");
    // merge repeat entries into one slot
    let ea2 = h.enter_ix(a.pk, a.pk, 5 * D, None);
    h.ok(ER, &[&a.kp], &[ea2], "a enters again");
    let t = h.table();
    assert_eq!(t.entry_count, 2);
    assert_eq!(t.pot, 20 * D);
    assert_eq!(t.entries[0].amount, 10 * D);
    assert_i2(&h, &[a.pk, b.pk]);
    h.advance(ROUND_SECS as i64 + 1);
    let c = h.close_ix(closed_by::KEEPER);
    h.ok(ER, &[&a.kp], &[c], "close");
    let t = h.table();
    assert_eq!(t.status, table_status::AWAITING_VRF);
    assert_eq!(t.vrf_nonce, 1);
    assert_eq!(t.closed_by, closed_by::KEEPER);
    assert_eq!(h.tick_slot(), 1, "one VRF fulfillment");
    let t = h.table();
    assert_eq!(t.status, table_status::DRAWN);
    let winner = t.entries[t.winner_idx as usize].player;
    let s = h.settle_round_ix(1, winner);
    h.ok(ER, &[&a.kp], &[s], "settle");
    let t = h.table();
    assert_eq!(t.round_id, 2, "next round opened");
    assert_eq!(t.status, table_status::OPEN);
    assert_eq!(t.rounds_settled, 1);
    let r = t.history[0];
    assert_eq!(r.outcome, round_outcome::SETTLED);
    assert_i6(&r, &[a.pk, b.pk], &[10 * D, 10 * D]);
    let wl = h.ledger(ER, &winner);
    assert_eq!(wl.available, 40 * D + 20 * D - 400_000, "winner credited pot − 2%");
    assert_eq!(h.ledger(ER, &h.treasury.clone()).available, 400_000, "fee to treasury");
    assert_i2(&h, &[a.pk, b.pk]);
    // Durable proof: the table was committed to L1 with the history.
    let l1 = h.table_l1();
    assert_eq!(l1.history[0].round_id, 1);
    assert_eq!(l1.history[0].winner, winner);
    // A17: settle twice
    let s = h.settle_round_ix(1, winner);
    assert!(h.fail(ER, &[&a.kp], &[s], "settle twice").has("AlreadySettled"));
}

#[test]
fn a18_settle_with_wrong_winner_rejected() {
    let mut h = H::new();
    let a = h.player(50 * D);
    let b = h.player(50 * D);
    for (p, amt) in [(&a, 5 * D), (&b, 5 * D)] {
        let e = h.enter_ix(p.pk, p.pk, amt, None);
        h.ok(ER, &[&p.kp], &[e], "enter");
    }
    h.advance(ROUND_SECS as i64 + 1);
    let c = h.close_ix(closed_by::KEEPER);
    h.ok(ER, &[&a.kp], &[c], "close");
    h.tick_slot();
    let t = h.table();
    let winner = t.entries[t.winner_idx as usize].player;
    let loser = if winner == a.pk { b.pk } else { a.pk };
    let s = h.settle_round_ix(1, loser);
    assert!(h.fail(ER, &[&a.kp], &[s], "wrong winner").has("WrongWinner"));
    let s = h.settle_round_ix(1, winner);
    h.ok(ER, &[&a.kp], &[s], "right winner");
}

#[test]
fn v2_retry_makes_old_callback_stale() {
    let mut h = H::new();
    let a = h.player(50 * D);
    let b = h.player(50 * D);
    for p in [&a, &b] {
        let e = h.enter_ix(p.pk, p.pk, 5 * D, None);
        h.ok(ER, &[&p.kp], &[e], "enter");
    }
    h.advance(ROUND_SECS as i64 + 1);
    let c = h.close_ix(closed_by::KEEPER);
    h.ok(ER, &[&a.kp], &[c], "close (nonce 1)");
    // retry too early
    let r = h.retry_ix();
    assert!(h.fail(ER, &[&a.kp], &[r.clone()], "early retry").has("RetryTooEarly"));
    h.advance(RETRY_SECS as i64);
    h.ok(ER, &[&a.kp], &[r], "retry (nonce 2)");
    assert_eq!(h.table().vrf_nonce, 2);
    // Both requests are fulfilled: the nonce-1 callback must be ignored.
    let n = h.tick_slot();
    assert_eq!(n, 2);
    let t = h.table();
    assert_eq!(t.status, table_status::DRAWN);
    assert_eq!(t.stale_callbacks, 1, "A14: stale nonce ignored");
    assert_eq!(t.vrf_retries, 1);
}

#[test]
fn v3_no_callback_void_refunds_and_late_callback_is_noop() {
    let mut h = H::new();
    let a = h.player(50 * D);
    let b = h.player(50 * D);
    for (p, amt) in [(&a, 7 * D), (&b, 3 * D)] {
        let e = h.enter_ix(p.pk, p.pk, amt, None);
        h.ok(ER, &[&p.kp], &[e], "enter");
    }
    h.advance(ROUND_SECS as i64 + 1);
    let c = h.close_ix(closed_by::KEEPER);
    h.ok(ER, &[&a.kp], &[c], "close");
    // A16: void too early
    let v = h.void_ix(1, &[a.ledger, b.ledger]);
    assert!(h.fail(ER, &[&a.kp], &[v.clone()], "early void").has("VoidTooEarly"));
    h.advance(h.void_secs as i64);
    // wrong order / missing refunds rejected (all-or-nothing)
    let bad = h.void_ix(1, &[b.ledger, a.ledger]);
    assert!(h.fail(ER, &[&a.kp], &[bad], "wrong order").has("BadRefundAccounts"));
    let bad = h.void_ix(1, &[a.ledger]);
    assert!(h.fail(ER, &[&a.kp], &[bad], "missing ledger").has("BadRefundAccounts"));
    h.ok(ER, &[&a.kp], &[v], "void");
    assert_eq!(h.ledger(ER, &a.pk).available, 50 * D, "full refund a");
    assert_eq!(h.ledger(ER, &b.pk).available, 50 * D, "full refund b");
    let t = h.table();
    assert_eq!(t.rounds_voided, 1);
    assert_eq!(t.round_id, 2);
    assert_eq!(t.history[0].outcome, round_outcome::VOIDED);
    // A15: the VRF callback arrives after void -> stale no-op
    h.tick_slot();
    let t = h.table();
    assert_eq!(t.stale_callbacks, 1);
    assert_eq!(t.status, table_status::OPEN);
    assert_i2(&h, &[a.pk, b.pk]);
}

#[test]
fn v4_void_refunds_32_entrants() {
    let mut h = H::new();
    let players: Vec<Player> = (0..32).map(|_| h.player(10 * D)).collect();
    for p in &players {
        let e = h.enter_ix(p.pk, p.pk, D, None);
        h.ok(ER, &[&p.kp], &[e], "enter");
    }
    // A12b: 33rd distinct player -> TableFull
    let extra = h.player(10 * D);
    let e = h.enter_ix(extra.pk, extra.pk, D, None);
    assert!(h.fail(ER, &[&extra.kp], &[e], "33rd").has("TableFull"));
    h.advance(ROUND_SECS as i64 + 1);
    let c = h.close_ix(closed_by::KEEPER);
    h.ok(ER, &[&players[0].kp], &[c], "close");
    h.advance(h.void_secs as i64);
    let ledgers: Vec<Pubkey> = players.iter().map(|p| p.ledger).collect();
    let v = h.void_ix(1, &ledgers);
    match h.send(ER, &[&players[0].kp], &[cu_limit(1_400_000), v]) {
        Ok(()) => {
            for p in &players {
                assert_eq!(h.ledger(ER, &p.pk).available, 10 * D);
            }
            eprintln!("V4: 32-entrant void refunded in ONE ER transaction");
        }
        Err(f) => panic!("32-entrant void failed: {:?}\n{}", f.err, f.logs),
    }
}

#[test]
fn a11_a12_entry_rules() {
    let mut h = H::new();
    let a = h.player(100 * D);
    let b = h.player(100 * D);
    // second faucet + deposit so `a` holds more than the per-round cap
    h.advance(6 * 3600 + 1);
    let (f, d, i) = (h.faucet_ix(a.pk), h.deposit_ix(a.pk, 1, 50 * D), h.ingest_ix(a.pk, 1));
    h.ok(L1, &[&a.kp], &[f, d], "faucet+deposit");
    h.ok(ER, &[&a.kp], &[i], "ingest");
    // per-player cap (100 dUSDC per round)
    for _ in 0..4 {
        let e = h.enter_ix(a.pk, a.pk, 25 * D, None);
        h.ok(ER, &[&a.kp], &[e], "25");
    }
    let e = h.enter_ix(a.pk, a.pk, D, None);
    assert!(h.fail(ER, &[&a.kp], &[e], "cap").has("PlayerCapExceeded"));
    // chip bounds
    let e = h.enter_ix(b.pk, b.pk, 26 * D, None);
    assert!(h.fail(ER, &[&b.kp], &[e], "max chip").has("AmountTooLarge"));
    let e = h.enter_ix(b.pk, b.pk, D / 2, None);
    assert!(h.fail(ER, &[&b.kp], &[e], "min chip").has("AmountTooSmall"));
    // A11: after closes_ts
    h.advance(ROUND_SECS as i64);
    let e = h.enter_ix(b.pk, b.pk, D, None);
    assert!(h.fail(ER, &[&b.kp], &[e], "late").has("RoundClosed"));
    // someone else cannot enter with a's ledger
    let e = h.enter_ix(b.pk, a.pk, D, None);
    assert!(h.fail(ER, &[&b.kp], &[e], "foreign ledger").has("Unauthorized"));
}

#[test]
fn solo_round_extends_and_player_can_leave() {
    let mut h = H::new();
    let a = h.player(20 * D);
    let e = h.enter_ix(a.pk, a.pk, 5 * D, None);
    h.ok(ER, &[&a.kp], &[e], "solo");
    let closes = h.table().closes_ts;
    h.advance(ROUND_SECS as i64 + 1);
    let c = h.close_ix(closed_by::KEEPER);
    h.ok(ER, &[&a.kp], &[c], "close solo");
    let t = h.table();
    assert_eq!(t.status, table_status::OPEN, "no VRF with one player");
    assert!(t.closes_ts > closes, "extended");
    let l = h.leave_solo_ix(a.pk, a.pk);
    h.ok(ER, &[&a.kp], &[l], "leave");
    assert_eq!(h.ledger(ER, &a.pk).available, 20 * D);
    assert_eq!(h.table().pot, 0);
}

#[test]
fn a26_crankable_tick_called_early_is_a_noop() {
    let mut h = H::new();
    let a = h.player(20 * D);
    let b = h.player(20 * D);
    let rnd = Keypair::new();
    h.svm.airdrop(&rnd.pubkey(), 1_000_000_000).unwrap();
    let before = h.svm.get_account_for(ER, &addr(h.table)).unwrap().data;
    let c = h.close_ix(closed_by::PLAYER);
    h.ok(ER, &[&rnd], &[c.clone()], "idle tick");
    for p in [&a, &b] {
        let e = h.enter_ix(p.pk, p.pk, D, None);
        h.ok(ER, &[&p.kp], &[e], "enter");
    }
    let mid = h.svm.get_account_for(ER, &addr(h.table)).unwrap().data;
    h.ok(ER, &[&rnd], &[c], "early tick");
    let after = h.svm.get_account_for(ER, &addr(h.table)).unwrap().data;
    assert_eq!(mid, after, "early tick changed no state");
    assert_ne!(before, mid);
    // other permissionless ixs reject early calls with errors
    let r = h.retry_ix();
    assert!(h.fail(ER, &[&rnd], &[r], "retry while open").has("NotAwaitingVrf"));
    let v = h.void_ix(1, &[a.ledger, b.ledger]);
    assert!(h.fail(ER, &[&rnd], &[v], "void while open").has("NotAwaitingVrf"));
    let s = h.settle_round_ix(1, a.pk);
    assert!(h.fail(ER, &[&rnd], &[s], "settle while open").has("NotDrawn"));
}

#[test]
fn a13_vrf_callback_requires_scoped_identity_signer() {
    let mut h = H::new();
    let a = h.player(20 * D);
    let b = h.player(20 * D);
    for p in [&a, &b] {
        let e = h.enter_ix(p.pk, p.pk, D, None);
        h.ok(ER, &[&p.kp], &[e], "enter");
    }
    h.advance(ROUND_SECS as i64 + 1);
    let c = h.close_ix(closed_by::KEEPER);
    h.ok(ER, &[&a.kp], &[c], "close");
    let fake = Keypair::new();
    h.svm.airdrop(&fake.pubkey(), 1_000_000_000).unwrap();
    let cb = h.vrf_callback_ix(kp_pk(&fake), [7u8; 32], 1, 1);
    let f = h.fail(ER, &[&fake], &[cb], "spoofed callback");
    assert!(f.has("Unauthorized") || f.has("ConstraintAddress"), "{}", f.logs);
    assert_eq!(h.table().status, table_status::AWAITING_VRF);
}

#[test]
fn sixty_rounds_conserve_value_and_recompute() {
    let mut h = H::new();
    let ps: Vec<Player> = (0..4).map(|_| h.player(100 * D)).collect();
    let owners: Vec<Pubkey> = ps.iter().map(|p| p.pk).collect();
    let mut rnd_seed = 1u8;
    for round in 0..60u64 {
        h.svm.set_vrf_randomness(Some([rnd_seed; 32]));
        rnd_seed = rnd_seed.wrapping_mul(31).wrapping_add(7);
        let a = &ps[(round % 4) as usize];
        let b = &ps[((round + 1) % 4) as usize];
        let entrants = [(a, D), (b, 2 * D)];
        let (rid, _w) = h.play_round(&entrants);
        assert_eq!(rid, round + 1);
        let t = h.table();
        let r = t.history[(round % 16) as usize];
        assert_eq!(r.round_id, round + 1);
        assert_i6(&r, &[a.pk, b.pk], &[D, 2 * D]);
        assert_i2(&h, &owners);
    }
    assert_eq!(h.table().rounds_settled, 60);
}

#[test]
fn crank_schedules_and_closes_rounds() {
    let mut h = H::new();
    let a = h.player(20 * D);
    let b = h.player(20 * D);
    let admin = clone_kp(&h.admin);
    let sc = ix(
        landed::instruction::ScheduleCrank {},
        landed::accounts::ScheduleCrank {
            admin: kp_pk(&admin),
            config: h.config,
            table: h.table,
            oracle_queue: EPH_QUEUE,
            instructions: IX_SYSVAR,
            program: landed::ID,
            magic_program: ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID,
            program_identity: pda(&[b"identity"]),
            vrf_program: VRF_PROGRAM,
            slot_hashes: SLOT_HASHES,
            system_program: SYSTEM,
        },
    );
    h.ok(ER, &[&admin], &[sc], "schedule crank");
    for p in [&a, &b] {
        let e = h.enter_ix(p.pk, p.pk, 2 * D, None);
        h.ok(ER, &[&p.kp], &[e], "enter");
    }
    h.advance(ROUND_SECS as i64 + 1);
    // 2,000 ms interval at 50 ms slots -> due within 40 slots; then VRF one slot later.
    let t0 = h.now();
    let s = h.slot();
    h.svm.warp_to_slot(s + 100);
    h.set_time(t0);
    let t = h.table();
    assert_eq!(t.status, table_status::DRAWN, "crank closed the round and VRF drew it (status={})", t.status);
    eprintln!("crank: closes_by_crank={} closes_by_keeper={} task_id={}", t.closes_by_crank, t.closes_by_keeper, t.crank_task_id);
}
