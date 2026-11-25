extern crate std;
use super::*;
use proptest::prelude::*;
use rand::{RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use std::{format, string::String, vec, vec::Vec};

fn rnd_from_u128(v: u128) -> [u8; 32] {
    let mut r = [0u8; 32];
    r[0..16].copy_from_slice(&v.to_le_bytes());
    r
}

// ---------- U1 winner selection boundaries ----------
#[test]
fn u1_target_zero_picks_first() {
    assert_eq!(select_winner(&rnd_from_u128(0), &[5, 5]), Some(0));
}
#[test]
fn u1_target_pot_minus_one_picks_last() {
    // pot = 10, r = 9 -> target 9 -> cumsum 5,10 -> idx 1
    assert_eq!(select_winner(&rnd_from_u128(9), &[5, 5]), Some(1));
    // r = 10 -> target 0 -> idx 0 (wraps)
    assert_eq!(select_winner(&rnd_from_u128(10), &[5, 5]), Some(0));
}
#[test]
fn u1_boundary_exact_cumsum() {
    // target == 4 is still entry 0 (cum 5 > 4); target 5 -> entry 1
    assert_eq!(select_winner(&rnd_from_u128(4), &[5, 5]), Some(0));
    assert_eq!(select_winner(&rnd_from_u128(5), &[5, 5]), Some(1));
}
#[test]
fn u1_single_entry_always_wins() {
    for v in [0u128, 1, 7, u128::MAX] {
        assert_eq!(select_winner(&rnd_from_u128(v), &[1_000_000]), Some(0));
    }
}
#[test]
fn u1_max_entries() {
    let amounts = vec![1u64; MAX_ENTRIES];
    for t in 0..MAX_ENTRIES as u128 {
        assert_eq!(select_winner(&rnd_from_u128(t), &amounts), Some(t as usize));
    }
}
#[test]
fn u1_empty_and_zero_pot() {
    assert_eq!(select_winner(&[7u8; 32], &[]), None);
    assert_eq!(select_winner(&[7u8; 32], &[0, 0]), None);
}
#[test]
fn u1_u64_max_pot() {
    assert_eq!(select_winner(&[0xff; 32], &[u64::MAX]), Some(0));
    assert_eq!(select_winner(&[0xff; 32], &[u64::MAX, 1]), None, "overflow is rejected");
    let w = select_winner(&[0xab; 32], &[u64::MAX / 2, u64::MAX / 2]).unwrap();
    assert!(w < 2);
}
#[test]
fn u1_zero_amount_entry_never_wins() {
    for v in 0..20u128 {
        let w = select_winner(&rnd_from_u128(v), &[3, 0, 4]).unwrap();
        assert_ne!(w, 1);
    }
}

// ---------- U2 fee math ----------
#[test]
fn u2_fee_rounding() {
    assert_eq!(house_fee(100, 200), Some(2));
    assert_eq!(house_fee(49, 200), Some(0)); // 0.98 floors to 0
    assert_eq!(house_fee(50, 200), Some(1));
    assert_eq!(house_fee(1_000_000, 200), Some(20_000));
    assert_eq!(house_fee(u64::MAX, 200), Some((u64::MAX as u128 * 200 / 10_000) as u64));
}
#[test]
fn u2_zero_and_max_bps() {
    assert_eq!(house_fee(12345, 0), Some(0));
    assert_eq!(house_fee(12345, 10_000), Some(12345));
    assert_eq!(house_fee(12345, 10_001), None);
    assert_eq!(split_pot(12345, 10_000), Some((0, 12345)));
}

// ---------- U3 ring buffer ----------
#[test]
fn u3_ring_wraps_and_blocks_when_full() {
    let mut r = Ring::default();
    for i in 0..RING_SIZE as u64 {
        assert_eq!(r.push(10).unwrap(), i);
    }
    assert_eq!(r.push(10), Err(RingError::RingFull), "17th unacked withdrawal blocked");
    r.ack(0).unwrap();
    assert_eq!(r.push(11).unwrap(), 16, "slot 0 reused only after ack");
    assert_eq!(r.slots[0].nonce, 16);
    assert_eq!(r.push(12), Err(RingError::RingFull), "slot 1 still pending");
}
#[test]
fn u3_ack_rules() {
    let mut r = Ring::default();
    let n = r.push(5).unwrap();
    assert_eq!(r.ack(n + 16), Err(RingError::WrongNonce));
    r.ack(n).unwrap();
    assert_eq!(r.ack(n), Err(RingError::NotPending), "double ack rejected");
    assert!(r.pending(n).is_none());
}
#[test]
fn u3_pending_lookup_matches_nonce_only() {
    let mut r = Ring::default();
    let n = r.push(5).unwrap();
    assert_eq!(r.pending(n).unwrap().amount, 5);
    assert!(r.pending(n + RING_SIZE as u64).is_none(), "aliasing nonce never pays");
}

#[test]
fn crank_task_id_is_positive_and_distinct() {
    let a = crank_task_id(&[1; 32], &[2; 32]);
    let b = crank_task_id(&[1; 32], &[3; 32]);
    assert!(a >= 0 && b >= 0);
    assert_ne!(a, b);
}

#[test]
fn needle_is_inside_winner_segment() {
    let amounts = [3u64, 7, 10];
    for v in 0..40u128 {
        let rnd = rnd_from_u128(v);
        let w = select_winner(&rnd, &amounts).unwrap();
        let (num, den) = needle_position(&rnd, 20).unwrap();
        let lo: u64 = amounts[..w].iter().sum();
        let hi = lo + amounts[w];
        // lo/20 < num/den < hi/20
        assert!((lo as u128) * den < num * 20 && num * 20 < (hi as u128) * den);
    }
}

// ---------- property tests ----------
proptest! {
    // P1 conservation
    #[test]
    fn p1_conservation(pot in any::<u64>(), bps in 0u16..=10_000) {
        let (w, f) = split_pot(pot, bps).unwrap();
        prop_assert_eq!(w as u128 + f as u128, pot as u128);
        prop_assert!(f <= pot);
    }

    // P1b winner always an index with a non-zero amount
    #[test]
    fn p1_winner_valid(amounts in proptest::collection::vec(0u64..1_000_000_000, 1..32), seed in any::<[u8;32]>()) {
        match select_winner(&seed, &amounts) {
            Some(i) => { prop_assert!(i < amounts.len()); prop_assert!(amounts[i] > 0); }
            None => prop_assert_eq!(amounts.iter().sum::<u64>(), 0),
        }
    }

    // P3 no overflow / panic on arbitrary u64 inputs
    #[test]
    fn p3_no_panic(amounts in proptest::collection::vec(any::<u64>(), 0..33), seed in any::<[u8;32]>(), bps in any::<u16>()) {
        let _ = select_winner(&seed, &amounts);
        for a in &amounts { let _ = house_fee(*a, bps); }
        let players: Vec<[u8;32]> = amounts.iter().map(|_| [9u8;32]).collect();
        let _ = entries_hash(&players, &amounts);
    }

    // ring never overwrites a pending slot
    #[test]
    fn p_ring_never_overwrites_pending(ops in proptest::collection::vec(any::<bool>(), 0..200)) {
        let mut r = Ring::default();
        let mut outstanding: Vec<u64> = Vec::new();
        for push in ops {
            if push {
                match r.push(1) {
                    Ok(n) => outstanding.push(n),
                    Err(RingError::RingFull) => prop_assert_eq!(outstanding.iter().filter(|n| ring_slot(**n) == ring_slot(r.next_nonce)).count(), 1),
                    Err(e) => prop_assert!(false, "{:?}", e),
                }
            } else if let Some(n) = outstanding.first().copied() {
                r.ack(n).unwrap();
                outstanding.remove(0);
            }
            for n in &outstanding { prop_assert!(r.pending(*n).is_some(), "pending {} lost", n); }
        }
    }
}

// ---------- P2 fairness (chi-square) ----------
#[test]
fn p2_fairness_chi_square() {
    let stakes = [1u64, 5, 10, 25, 9, 50];
    let pot: u64 = stakes.iter().sum();
    let draws = 200_000usize;
    let mut rng = ChaCha20Rng::seed_from_u64(0x1a2d_ed00);
    let mut counts = [0usize; 6];
    for _ in 0..draws {
        let mut r = [0u8; 32];
        rng.fill_bytes(&mut r);
        counts[select_winner(&r, &stakes).unwrap()] += 1;
    }
    let mut chi2 = 0.0f64;
    for i in 0..stakes.len() {
        let exp = draws as f64 * stakes[i] as f64 / pot as f64;
        let d = counts[i] as f64 - exp;
        chi2 += d * d / exp;
    }
    // df = 5; critical value for p = 0.01 is 15.086
    std::println!("P2 counts={:?} chi2={:.3} (df=5, crit@p=0.01=15.086)", counts, chi2);
    let report = format!(
        "{{\"test\":\"P2\",\"draws\":{},\"stakes\":{:?},\"counts\":{:?},\"chi2\":{:.4},\"df\":5,\"critical_p01\":15.086,\"pass\":{}}}\n",
        draws, stakes, counts, chi2, chi2 < 15.086
    );
    let _ = std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/p2-report.json"), report);
    assert!(chi2 < 15.086, "chi2 {} too large", chi2);
}

// ---------- golden vectors ----------
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

#[test]
fn golden_vectors_export() {
    let mut rng = ChaCha20Rng::seed_from_u64(42);
    let mut cases = Vec::new();
    let fixed: Vec<(Vec<u64>, [u8; 32])> = vec![
        (vec![5, 5], rnd_from_u128(0)),
        (vec![5, 5], rnd_from_u128(9)),
        (vec![1_000_000, 5_000_000, 10_000_000], [0xff; 32]),
        (vec![u64::MAX], [0x11; 32]),
        (vec![25_000_000; 32], [0x42; 32]),
    ];
    for (amounts, rnd) in fixed {
        cases.push((amounts, rnd));
    }
    for _ in 0..60 {
        let n = (rng.next_u32() % 32 + 1) as usize;
        let amounts: Vec<u64> = (0..n).map(|_| [1u64, 5, 10, 25][(rng.next_u32() % 4) as usize] * 1_000_000 * (1 + (rng.next_u32() % 3) as u64)).collect();
        let mut rnd = [0u8; 32];
        rng.fill_bytes(&mut rnd);
        cases.push((amounts, rnd));
    }
    let mut out = String::from("{\n  \"description\": \"landed-core golden vectors; the TS verifier must reproduce every field bit-for-bit\",\n  \"house_fee_bps\": 200,\n  \"winner_cases\": [\n");
    for (i, (amounts, rnd)) in cases.iter().enumerate() {
        let pot: u128 = amounts.iter().map(|a| *a as u128).sum();
        let winner = select_winner(rnd, amounts);
        let target = if pot <= u64::MAX as u128 { draw_target(rnd, pot as u64) } else { None };
        let fee = if pot <= u64::MAX as u128 { house_fee(pot as u64, 200) } else { None };
        let players: Vec<[u8; 32]> = (0..amounts.len()).map(|k| { let mut p = [0u8; 32]; p[0] = k as u8; p[31] = 0xAA; p }).collect();
        let eh = entries_hash(&players, amounts);
        let seed = vrf_caller_seed(1, i as u64, &eh, 1_700_000_000 + i as i64, (i % 3) as u64);
        out.push_str(&format!(
            "    {{\"amounts\": [{}], \"randomness\": \"{}\", \"pot\": \"{}\", \"target\": {}, \"winner\": {}, \"fee\": {}, \"entries_hash\": \"{}\", \"caller_seed\": {{\"table_id\": 1, \"round_id\": {}, \"closes_ts\": {}, \"vrf_nonce\": {}, \"seed\": \"{}\"}}}}{}\n",
            amounts.iter().map(|a| format!("\"{}\"", a)).collect::<Vec<_>>().join(", "),
            hex(rnd), pot,
            target.map(|t| format!("\"{}\"", t)).unwrap_or("null".into()),
            winner.map(|w| format!("{}", w)).unwrap_or("null".into()),
            fee.map(|f| format!("\"{}\"", f)).unwrap_or("null".into()),
            hex(&eh), i, 1_700_000_000 + i as i64, i % 3, hex(&seed),
            if i + 1 == cases.len() { "" } else { "," }
        ));
    }
    out.push_str("  ],\n  \"fee_cases\": [\n");
    let fees = [(0u64, 200u16), (49, 200), (50, 200), (100, 200), (1_000_000, 200), (u64::MAX, 200), (12345, 0), (12345, 10_000), (999_999, 250)];
    for (i, (pot, bps)) in fees.iter().enumerate() {
        out.push_str(&format!("    {{\"pot\": \"{}\", \"bps\": {}, \"fee\": \"{}\"}}{}\n", pot, bps, house_fee(*pot, *bps).unwrap(), if i + 1 == fees.len() { "" } else { "," }));
    }
    let tid = crank_task_id(&[1; 32], &[2; 32]);
    out.push_str(&format!("  ],\n  \"crank_task_id\": {{\"program_id\": \"{}\", \"table\": \"{}\", \"task_id\": \"{}\"}}\n}}\n", hex(&[1; 32]), hex(&[2; 32]), tid));
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/vectors.json"), out).unwrap();
}
