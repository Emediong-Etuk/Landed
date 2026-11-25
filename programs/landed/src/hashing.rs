//! On-chain hashing through the `sol_sha256` syscall (cheap). Byte-for-byte the
//! same as `landed_core::{entries_hash, vrf_caller_seed}` (software sha2, used by
//! tests, the golden vectors and the TS verifier); `tests` below asserts equality.
use solana_sha256_hasher::hashv;

pub fn entries_hash(players: &[[u8; 32]], amounts: &[u64]) -> [u8; 32] {
    let n = core::cmp::min(players.len(), amounts.len());
    let count = (n as u32).to_le_bytes();
    let amts: Vec<[u8; 8]> = amounts[..n].iter().map(|a| a.to_le_bytes()).collect();
    let mut parts: Vec<&[u8]> = Vec::with_capacity(1 + 2 * n);
    parts.push(&count);
    for i in 0..n {
        parts.push(&players[i]);
        parts.push(&amts[i]);
    }
    hashv(&parts).to_bytes()
}

pub fn vrf_caller_seed(table_id: u64, round_id: u64, entries_hash: &[u8; 32], closes_ts: i64, vrf_nonce: u64) -> [u8; 32] {
    hashv(&[
        b"landed-vrf",
        &table_id.to_le_bytes(),
        &round_id.to_le_bytes(),
        entries_hash,
        &closes_ts.to_le_bytes(),
        &vrf_nonce.to_le_bytes(),
    ])
    .to_bytes()
}

pub fn crank_task_id(program_id: &[u8; 32], table: &[u8; 32]) -> i64 {
    let d = hashv(&[b"landed-crank", program_id, table]).to_bytes();
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[0..8]);
    i64::from_le_bytes(b) & i64::MAX
}

#[cfg(test)]
mod tests {
    #[test]
    fn syscall_hashing_matches_landed_core() {
        for n in 0..=32usize {
            let players: Vec<[u8; 32]> = (0..n).map(|i| [i as u8 ^ 0x5a; 32]).collect();
            let amounts: Vec<u64> = (0..n).map(|i| (i as u64 + 1) * 1_000_003).collect();
            let a = super::entries_hash(&players, &amounts);
            assert_eq!(a, landed_core::entries_hash(&players, &amounts));
            let s = super::vrf_caller_seed(1, n as u64, &a, 1_700_000_000 + n as i64, 3);
            assert_eq!(s, landed_core::vrf_caller_seed(1, n as u64, &a, 1_700_000_000 + n as i64, 3));
            assert_eq!(super::crank_task_id(&a, &s), landed_core::crank_task_id(&a, &s));
        }
    }
}
