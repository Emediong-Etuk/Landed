//! Dumps real account bytes after a full round + a rescued withdrawal, so the
//! TypeScript decoders (packages/sdk/src/layout.ts) can be checked byte-for-byte.
mod common;
use common::*;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

#[test]
fn dump_account_fixtures() {
    let mut h = H::new();
    let a = h.player(50 * D);
    let b = h.player(50 * D);
    h.svm.set_vrf_randomness(Some([9u8; 32]));
    let (_rid, _w) = h.play_round(&[(&a, 3 * D), (&b, 7 * D)]);
    let e = h.enter_ix(a.pk, a.pk, 2 * D, None);
    h.ok(ER, &[&a.kp], &[e], "enter next round");
    let w = h.request_withdraw_ix(a.pk, a.pk, 4 * D, true, None);
    h.ok(ER, &[&a.kp], &[w], "fault withdraw");
    let f = h.finalize_ix(kp_pk(&b.kp), a.pk, 0);
    h.ok(L1, &[&b.kp], &[f], "rescue by b");
    let get = |t, k: &anchor_lang::prelude::Pubkey| hex(&h.svm.get_account_for(t, &addr(*k)).unwrap().data);
    let la = h.ledger(ER, &a.pk);
    let t = h.table();
    let r = h.receipt(&a.pk, 0).unwrap();
    let json = format!(
        r#"{{
  "ledger_er": "{}",
  "ledger_l1": "{}",
  "table_er": "{}",
  "config": "{}",
  "receipt": "{}",
  "expect": {{
    "ledger_owner": "{}", "available": "{}", "ingested_total": "{}", "withdraw_nonce": "{}", "withdraw_requested_total": "{}",
    "ring0_amount": "{}", "ring0_state": {}, "ring0_fault": {}, "stats_rounds": "{}", "stats_wagered": "{}",
    "table_round_id": "{}", "table_pot": "{}", "table_status": {}, "table_entry_count": {}, "table_rounds_settled": "{}",
    "table_history_len": "{}", "h0_winner": "{}", "h0_pot": "{}", "h0_fee": "{}", "h0_randomness": "{}", "h0_entries_hash": "{}",
    "table_round_secs": {}, "table_void_secs": {}, "table_crank_task_id": "{}", "table_entry0": "{}",
    "receipt_amount": "{}", "receipt_path": {}, "receipt_rescuer": "{}"
  }}
}}"#,
        get(ER, &a.ledger), get(L1, &a.ledger), get(ER, &h.table), get(L1, &h.config), get(L1, &wdr_pda(&a.pk, 0)),
        la.owner, la.available, la.ingested_total, la.withdraw_nonce, la.withdraw_requested_total,
        la.ring[0].amount, la.ring[0].state, la.ring[0].fault, la.stats.rounds, la.stats.wagered,
        t.round_id, t.pot, t.status, t.entry_count, t.rounds_settled,
        t.history_len, t.history[0].winner, t.history[0].pot, t.history[0].fee, hex(&t.history[0].randomness), hex(&t.history[0].entries_hash),
        t.round_secs, t.vrf_void_secs, t.crank_task_id, t.entries[0].player,
        r.amount, r.path, r.rescuer
    );
    let out = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/sdk/test/fixtures/accounts.json");
    std::fs::write(&out, json).unwrap();
    eprintln!("wrote {}", out.display());
}
