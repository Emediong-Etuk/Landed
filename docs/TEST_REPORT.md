# Test report

Counts come from `evidence/tests/summary.json` (`pnpm test:all`) and `evidence/tests/e2e.json` (Playwright), last run **2026-11-25**. Devnet campaigns (C1–C7, L1) have **not run yet** because the deployer wallet is unfunded; their rows say so instead of showing numbers.

## Summary

| Layer | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|
| landed-core: unit + property + fairness (Rust, proptest) | 21 | 21 | 0 | 0 |
| landed program: unit (account sizes, syscall hashing = landed-core) | 3 | 3 | 0 | 0 |
| Program integration on MagicSVM (real Delegation + Magic programs, VRF, cranks) | 35 | 35 | 0 | 0 |
| sdk: golden vectors, byte-exact decoders, SettlementTracker (TS) | 14 | 14 | 0 | 0 |
| verifier: tamper fixtures (TS) | 10 | 10 | 0 | 0 |
| app: unit (TS) | 4 | 4 | 0 | 0 |
| Web E2E + axe a11y (Playwright, desktop + Pixel 7) | 19 | 19 | 0 | 1 (tour on mobile) |
| Web E2E against devnet (`e2e/devnet.spec.ts`) | 2 | — | — | 2 (needs deployment) |
| Devnet campaigns C1–C7, load L1 | — | not run | — | — |

## Metrics M1–M7

See `docs/EVIDENCE.md` (generated). Today: M3 and M4 are proven in MagicSVM; M1, M2, M5, M6 need devnet; M7 is enforced in MagicSVM (`assert_i2`, `assert_i6` after every round of a 60-round run) and by the verifier's fixtures.

## Per-ID results

### Pure logic (`crates/landed-core`)
| ID | Test | Result |
|---|---|---|
| U1 | winner boundaries: target 0, pot−1, exact cumsum, single entry, 32 entries, empty/zero pot, u64::MAX pot, zero-amount never wins | pass |
| U2 | fee rounding, 0 bps, 10,000 bps, > 10,000 rejected | pass |
| U3 | ring wrap, RingFull, ack-then-reuse, double ack, nonce aliasing | pass |
| P1 | conservation `credit + fee == pot` (proptest); winner always a non-zero entry | pass |
| P2 | fairness: 200,000 draws, stakes [1,5,10,25,9,50] → χ² = **3.19** (df 5, critical 15.09 at p = 0.01); counts in `crates/landed-core/p2-report.json` | pass |
| P3 | no panic/overflow on arbitrary u64 inputs | pass |
| — | golden vectors exported (`vectors.json`, 65 winner cases, 9 fee cases, crank id) | pass |

### Program on MagicSVM (`tests/magicsvm`)
| ID | Test | Result |
|---|---|---|
| happy | deposit → ingest exactly once in order; withdraw paid by the post-commit action; ack | pass |
| F1 | injected fault: commit lands without action, rollup debited, no receipt → third-party rescue pays the **owner**; second rescue fails | pass |
| S1-alt | "reverted" outcome: faulted action reverts the ER tx, nothing debited | pass |
| A1 | direct `settle_withdraw` without the escrow signer | rejected |
| A2 | foreign escrow authority (signing attacker key; unsignable foreign escrow PDA) | rejected |
| A3 | `finalize_withdraw` twice | 2nd rejected |
| A4 | action + rescue race | exactly one pays |
| A5 | forged ledger (other user's PDA; Config as ledger) | rejected `InvalidLedger` |
| A6 | rescue redirected to the rescuer's ATA | rejected `ConstraintTokenOwner`; honest stranger rescue pays the owner |
| A7–A10 | session withdraw goes to owner; cap; missing token; V1 token (`AccountDiscriminatorMismatch`); other program; expiry; stranger | all enforced |
| A11–A12 | late entry, per-player cap, chip bounds, foreign ledger, 33rd player `TableFull` | rejected |
| A13 | spoofed VRF callback | rejected |
| A14 / V2 | retry → old-nonce callback ignored (`stale_callbacks = 1`), new one draws | pass |
| A15 / V3 | callback after void is a no-op | pass |
| A16 | void before timeout / wrong order / missing ledger | rejected |
| A17 / A18 | settle twice; wrong winner ledger | rejected |
| A19 | ingest twice, out of order, forged receipt | rejected |
| A20 | 17th unacked withdrawal `RingFull`; slot reused only after rescue + ack | pass |
| A21 | pause blocks deposits/entries, not withdrawals or rescues; non-admin can't pause | pass |
| A22 | admin has no path to vault funds (account confusion attempts) | rejected |
| A23 | faucet cooldown + lifetime cap (990 dUSDC after 10 claims) | pass |
| A24 | `inject_fault` in the non-`fault-lab` build → `FaultLabDisabled` | pass |
| A25 | Ledger 601 B, Table 3,848 B ≤ 10,240 | pass |
| A26 | crank tick called early by a random wallet → no state change (byte-identical table) | pass |
| A27 | huge/zero amounts | rejected |
| V1 | close → VRF → callback → settle; I2 and I6 hold; table committed to L1 with history | pass |
| V4 | 32-entrant void refunded in **one** ER transaction (1.4M CU limit) | pass |
| F2/M3 | 30 cash-outs in one delegation session, each paid and acked | pass |
| crank | `schedule_crank` → scheduled `close_round` closes the round, VRF draws it | pass |
| C2-sim | 60 consecutive rounds with pinned randomness; I2 + I6 after every round | pass |
| request_commit | rate-limited (NothingPending, CommitTooEarly), then permissionless | pass |
| naive | baseline pays when nothing fails; fault behavior | pass |
| layout | real account bytes dumped for the TS decoder cross-check | pass |

### SDK / verifier / app (TS)
| ID | Test | Result |
|---|---|---|
| golden | every Rust vector (winner, target, fee, entries hash, VRF seed, crank id) reproduced bit-for-bit | pass |
| layout | Ledger (ER + committed L1), zero-copy Table, WithdrawReceipt, Config decoded from real program bytes | pass |
| tracker | happy path, dropped branch, stuck commit, idempotent receipt, reload recovery, deposit | pass |
| fixtures | phantom receipt, orphaned vault surplus, wrong winner, fee off by one, duplicate receipt, non-VRF randomness / tampered entries, owed > 60 s, I2 break, naive stranded | all flagged with precise messages; clean world passes |
| E2E | 7 routes × 2 viewports: render, axe (no serious/critical), no page errors, no horizontal scroll; full 10-step tour; verifier worker reports | pass |

## Failures found during development (and fixes)

1. **Faucet cooldown bypass.** MagicSVM's clock starts at 0, which revealed that `last_faucet_ts == 0` was treated as "never claimed". Fixed to `faucet_total == 0` (A23).
2. **`program_identity_pubkey()` at runtime burned 200k CU** (const fn evaluated in a normal expression → software PDA search). Fixed with a `const` item.
3. **`#[vrf_callback]` exceeded 200k CU on every callback**: the SDK macro evaluates `scoped_vrf_identity_const` at runtime. Fixed by declaring `vrf_program_identity` against a compile-time `const` (same check). Worth upstreaming.
4. **`opt-level = "s"` made software sha2 too slow** for a 32-entrant `close_round` (crank ticks can't raise their CU limit). Switched on-chain hashing to the `sol_sha256` syscall, byte-identical to landed-core (unit test 0–32 entries). The program shrank from 915 KB to 712 KB (~1.4 SOL less deploy rent).
5. **MagicSVM runs post-commit actions synchronously** (a failing action reverts the ER tx), so it can't reproduce the live F1 outcome. Added the test-only `sim-committor-drop` feature and a separate "reverted" test.
6. **Tour progress text empty and the tour stalled crossing to /play** (the target only existed after onboarding). Fixed the progress text and anchored the step on a container that always renders (caught by E2E).
7. **Landing page JS 263 KB → 162 KB** by moving wallet providers to `/play` and `/lab` and splitting the stats hook from the SDK.
8. **a11y**: a scrollable `<pre>` wasn't keyboard-focusable (axe `scrollable-region-focusable`). Fixed.

## Coverage notes

- Every program instruction has at least one happy-path and one adversarial test in MagicSVM. Line coverage was not measured: `cargo llvm-cov` doesn't instrument SBF binaries.

## Not tested (and why)

- **Live validator 2.0 behavior** (real committor action-drop semantics, commit cap, fees, Hydra cranks, real VRF oracle latency, ER cloning delay): requires devnet SOL. Commands are ready (`docs/PHASE0_FINDINGS.md`).
- **Wallet-adapter onboarding** with a real Phantom/Solflare extension: not automatable headless; guest flow covers the same instructions.
- **Lighthouse**: not run in this environment; landing-page JS is 162 KB (budget 200 KB).
- **`cargo audit`**: runs in CI.
