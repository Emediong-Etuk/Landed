# Security

Safety is enforced **on-chain first**, then in the backend, then in the UI. The UI is never the only guard.

## Threat model

| Asset | Threat | Mitigation | Enforced in | Test |
|---|---|---|---|---|
| Vault dUSDC | Anyone calls the `#[action]` payout handler directly (F5) | `escrow` must be a signer pinned to `ephemeral_balance_pda_from_payer(escrow_auth, 255)`; only the delegation program can sign it | program | `a1_direct_call_without_escrow_signer_fails` |
| Vault dUSDC | A foreign program schedules an action into our handler with its own escrow | `escrow_auth` bound to our `["escrow_auth"]` PDA (seeds constraint); `source_program == crate::ID` | program | `a2_foreign_escrow_authority_rejected` |
| Vault dUSDC | Double payment (action + rescue, or two rescues) | Payment requires `init` of the unique `WithdrawReceipt[owner, nonce]` PDA | program | `f1_…`, `a4_action_and_rescue_race_exactly_one_pays` |
| Vault dUSDC | Forged/foreign ledger presented to the payout | Ledger PDA from `owner`, account owner ∈ {delegation program, landed}, discriminator, `try_deserialize`, `ledger.owner == owner`, entry must be Pending at that nonce | program | `a5_forged_ledger_accounts_rejected` |
| Vault dUSDC | Amount or destination manipulated through args | Only `(owner, nonce)` are args; amount from the committed ring; destination = owner's ATA (`associated_token::authority = owner`) | program | `a6_destination_cannot_be_redirected` |
| Vault dUSDC | Admin drains vault | No instruction moves vault funds except the two payout paths; admin can only pause entries/deposits | program | `a22_admin_has_no_path_to_vault_funds` |
| Vault dUSDC | Partial payment / insolvency | `vault.amount ≥ amount` or error (stays owed); I1/I4 checked by the verifier | program + verifier | verifier fixtures |
| Player balance | Withdrawal debited but never paid (F1) | Pending entry committed before payment; permissionless `finalize_withdraw` + `request_commit`; UI auto-rescues after 8 s; keeper too | program + UI + keeper | `f1_injected_fault_action_dropped_then_rescued_by_third_party`, `request_commit_is_rate_limited_and_permissionless` |
| Player balance | Unpaid withdrawal overwritten in the ring | Slot reusable only when Empty or Acked; ack requires the L1 receipt | program | `a20_ring_full_blocks_17th_unacked_withdrawal`, `ack_requires_real_receipt` |
| Player balance | Deposit credited twice / out of order / forged | `n == ingested_count`; receipt PDA + owner + discriminator | program | `deposit_ingest_credits_exactly_once_in_order`, `a19c_forged_deposit_receipt_rejected` |
| Player balance | Stolen session key | Session signer can only `enter_round` (within cap & expiry), `leave_solo`, `request_withdraw` (to the owner); requires our ledger grant AND a valid `SessionTokenV2` for this program | program | `a7_a8_a9_a10_session_rules` |
| Player balance | V1 session token revoked by a stranger | `Account<SessionTokenV2>` only (V1 rejected by discriminator) | program | `a7_…_a10` |
| Round fairness | Forged randomness | `vrf_program_identity` must sign and equal the scoped identity PDA (compile-time constant) | program | `a13_vrf_callback_requires_scoped_identity_signer` |
| Round fairness | Late callback for a retried/voided round (F3) | `(status, round_id, vrf_nonce)` must match, else `StaleCallbackIgnored` no-op | program | `v2_retry_makes_old_callback_stale`, `v3_…` |
| Round fairness | Player grinds the seed | Seed = sha256 over locked entries hash + round + close time + nonce; players never supply it | program | design + I6 |
| Round liveness | Crank never runs (F4) / VRF never answers | Permissionless watchdog (page + keeper); retry after 20 s; void + full refund after 150 s | program + UI + keeper | `crank_schedules_and_closes_rounds`, `v3_…`, `v4_void_refunds_32_entrants` |
| Round state | Crankable/permissionless ix called early by anyone (F5) | Time + state checks; tick is a no-op when not due; others error | program | `a26_crankable_tick_called_early_is_a_noop` |
| Settle | Wrong winner credited / settled twice | Winner ledger must equal `entries[winner_idx]`; `round_id` arg must equal current round | program | `a18_…`, `v1_…` (AlreadySettled) |
| Accounts | Ledger/table grows past 10,240 B (F6) | Fixed arrays + `const` asserts | program (compile time) | `a25_sizes` |
| Fee payer | Griefers burn our fee payer via forced commits | `request_commit` requires a Pending withdrawal ≥ 5 s old | program | `request_commit_is_rate_limited_and_permissionless` |
| Fault Lab | Fault flag used against others / on mainnet | Flag only on the caller's own withdrawal; compiled out without `fault-lab` | program | `a24_inject_fault_rejected_without_fault_lab_feature` |
| Faucet | Unlimited minting | 100 dUSDC per 6 h, lifetime 1,000 on-chain; mint authority is a PDA | program | `a23_faucet_rate_limits` |
| Gas treasury | Top-up drained | 0.02 SOL only to the requesting key, only if < 0.01 SOL; 1/key/24 h, 3/IP/24 h, global daily budget; Turnstile; key only in server env | backend | code review (`app/src/app/api/guest/topup/route.ts`) |
| Keyed RPC | Key leak / abuse | Proxy keeps URL server-side; JSON-RPC method allowlist; 64 KB cap; per-IP rate limit | backend | code review (`/api/rpc`) |
| Guest key | Theft from storage | IndexedDB, encrypted with a non-extractable AES-GCM WebCrypto key; in-memory fallback; export behind warning | UI | limitation (XSS) |
| Users | Blind signing | Wallet users sign one batched setup (`signAllTransactions`); drops/cash-outs then need no popup; destination is always their own wallet | UI + program | — |
| Site | XSS / clickjacking | CSP, `frame-ancestors 'none'`, HSTS, nosniff, Referrer-Policy | backend | headers in `next.config.ts` |

## Audit checklist (manual pass)

- [x] **Signer checks**: every owner path uses `Signer` + `ledger.owner == signer` or the session path; admin paths `address = config.admin`.
- [x] **Owner checks**: typed `Account<T>` everywhere except deliberately unchecked committed ledgers/receipts, which check `owner` explicitly.
- [x] **PDA checks**: all PDAs have `seeds` constraints or explicit `find/create_program_address` comparisons.
- [x] **Arithmetic**: `checked_*` on every balance; `overflow-checks = true` in release; `a27_amount_bounds_and_overflow`.
- [x] **Reinitialization**: only `init` (never `init_if_needed`) for receipts, users, ledgers; `init_if_needed` only for the owner's ATA.
- [x] **Account confusion**: discriminators enforced by `Account<T>` / `try_deserialize`; config passed as ledger is rejected (A5).
- [x] **CPI targets**: token / ATA / system programs typed; VRF program typed by `#[vrf]`; magic program by address.
- [x] **remaining_accounts**: `void_round` validates count, writability, PDA (stored bump), owner and order; total refunded must equal the pot.
- [x] **Rent and close**: no account closing paths; rent for action-created accounts from the escrow, for rescues from the rescuer.
- [x] **Exits can't be blocked**: `paused`/`close_only` only gate deposits and entries.
- [ ] `cargo audit`: not run in this environment (crates.io advisory DB fetch); CI runs it.

## Trust assumptions

1. The MagicBlock ER validator eventually commits (Landed removes the *action* as a single point of failure, not the validator).
2. MagicBlock's VRF oracle eventually delivers (we handle delay and non-delivery, but can't force delivery).
3. Devnet only; test token; no real money.
