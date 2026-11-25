# Architecture

```
                          ┌────────────────────────── Solana devnet (L1) ───────────────────────────┐
  Player (guest burner    │ Config · dUSDC mint (PDA authority) · Vault (PDA authority)                │
  or wallet + session) ──►│ UserMeta[owner] · DepositReceipt[owner,n] · WithdrawReceipt[owner,n]      │
        │                 │ settle_withdraw  (#[action], escrow-signer pinned)  ◄── post-commit action │
        │                 │ finalize_withdraw (permissionless rescue, reads the COMMITTED ledger)      │
        │                 └───────────────▲──────────────────────────────┬────────────────────────────┘
        │                     commits (+actions)                 ER clones L1 receipts (read-only)
        │                 ┌───────────────┴────────── MagicBlock ER (devnet-eu, validator 2.0) ───────┐
        └── one-tap ─────►│ Ledger[owner] · Table[1] · Treasury Ledger · EscrowAuth (fee payer)       │
            (no popup)    │ enter_round · close_round (crank | anyone) · VRF ─► oracle ─► vrf_callback │
                          │ settle_round · retry_vrf · void_round · request_withdraw · ack · ingest   │
                          └────────────────────────────────────────────────────────────────────────────┘
  Keeper (optional; permissionless only): watchdog · rescue · ack · ingest · escrow top-ups · 2 labeled bots
  Verifier (CLI + browser): reads L1 + ER directly → I1–I6, round recomputation, receipt reconciliation
```

## Programs and crates

| Path | What |
|---|---|
| `programs/landed` | The game + settlement protocol (Anchor 1.0.2, `ephemeral-rollups-sdk` 0.18.0 with `anchor, vrf, crank`, `session-keys` 3.1.1). Feature `fault-lab` (devnet build only) lets a player mark **their own** withdrawal so the payout action fails; `sim-committor-drop` and `short-timers` exist only for MagicSVM tests. |
| `programs/naive-cashout` | **Baseline only**: the documented "commit + post-commit payout" pattern with no receipt and no rescue. Used by the Fault Lab and campaign C3. |
| `crates/landed-core` | Pure Rust: winner selection, fee math, ring buffer model, hashing. Exports golden vectors the TS verifier reproduces bit-for-bit. |
| `packages/sdk` | TS: PDAs, byte-exact decoders, instruction builders, the `SettlementTracker` state machine, `LandedClient` (every permissionless recovery step). |
| `packages/verifier` | TS: chain snapshot + I1–I6 + F-checks + naive stranded-funds check; CLI and browser Web Worker. |
| `app` | Next.js 15 site (`/`, `/play`, `/lab`, `/verify`, `/proof`, `/watch`, `/how-it-works`) + API routes (`/api/rpc`, `/api/guest/topup`, `/api/stats`, `/api/health`). |
| `services/keeper` | Optional keeper: watchdog, rescue, ack, ingest, top-ups, bots. Everything it does, anyone can do. |

## Accounts (sizes enforced at compile time, F6)

**L1 (never delegated)**

| Account | Seeds | Notes |
|---|---|---|
| `Config` | `["config"]` | admin, pending admin, mint, vault, ER validator, magic fee vault, treasury, fee bps (200), chip bounds, per-player cap, timers (20 / 20 / 150 s), pause flags, bumps |
| dUSDC mint | `["mint"]` | 6 decimals, authority PDA `["mint_auth"]` |
| Vault | `["vault"]` | SPL token account, authority PDA `["vault_auth"]` |
| `UserMeta` | `["user", owner]` | deposit count/total, faucet limits |
| `DepositReceipt` | `["dep", owner, n_le]` | unique per deposit; ingested once, in order |
| `WithdrawReceipt` | `["wdr", owner, n_le]` | unique per withdrawal; its `init` is the exactly-once guard. `path` 0 = action, 1 = rescue |
| Action escrow | DLP `["balance", escrow_auth, 255]` | funds rent for receipts/ATAs created by the action |

**ER (delegated)**

| Account | Seeds | Size | Notes |
|---|---|---|---|
| `Ledger` | `["ledger", owner]` | 601 B | available, ingest counters, withdraw nonce + requested total, 16-slot ring `{nonce, amount, requested_ts, state, fault}`, session grant `{signer, expires, cap, spent}`, stats |
| `Table` | `["table", id]` | 3,848 B (zero-copy) | round state, 32 entries, VRF nonce/attempts/timestamps, 16-round history ring, crank/watchdog telemetry |
| Treasury ledger | `["ledger", treasury_pda]` | 601 B | receives the 2% fee; counted in I2 |
| `EscrowAuth` | `["escrow_auth"]` | 9 B | delegated **fee payer** (fee-vault commit path, F2) **and** Magic Action escrow authority |

`const _: () = assert!(TABLE_SPACE <= 10_240)` (and Ledger) fail the build if an account would become uncommittable.

## Round lifecycle

```
Open ──(now ≥ closes_ts; crank | page | keeper | anyone)──► close_round
   < 2 players → extend by round_secs (no VRF); a solo player can leave_solo
   ≥ 2 → lock entries_hash, vrf_nonce++, request VRF (table PDA signs as payer) → AwaitingVrf
AwaitingVrf ──vrf_callback(randomness, round_id, nonce)──► Drawn   (mismatch ⇒ StaleCallbackIgnored, no-op)
AwaitingVrf ──(≥ 20 s since last request, < 3 attempts)──► retry (new nonce; also done by the crank tick)
AwaitingVrf ──(≥ 150 s since first request)──► void_round → refund every entry → next round
Drawn ──settle_round──► winner += pot − fee, treasury += fee, history push, commit table to L1, next round
```

Winner: `r = u128_le(randomness[0..16])`, `target = r mod pot`, first entry with cumulative stake > target. Caller seed = `sha256("landed-vrf" ‖ table ‖ round ‖ entries_hash ‖ closes_ts ‖ nonce)`: entries are locked at close, so nobody can grind it.

## Instruction table

Generated from the IDL by `scripts/gen-ix-table.ts`.

<!-- IX-TABLE:START -->
| Instruction | Layer | Signer | Accounts | State checks | Events | Errors |
|---|---|---|---|---|---|---|
| `accept_admin`() | L1 | pending admin | new_admin, config | address == pending_admin | — | — |
| `ack_withdrawal`(nonce) | ER | anyone | ledger, receipt | receipt PDA/owner/amount/nonce match Pending slot | WithdrawAcked | InvalidReceipt, NotPending |
| `clear_session`() | ER | owner | owner, ledger | — | — | — |
| `close_round`(caller_kind) | ER | anyone / crank (no signer) | table, oracle_queue, instructions, program_identity, vrf_program, slot_hashes, system_program | time-checked tick: close+VRF when due, retry when due, else no-op; closed_by from instructions sysvar | RoundClosed, RoundExtended, VrfRetried | — |
| `create_table`(id) | L1 | admin | admin, config, table, system_program | snapshot of config timers/fee; derived crank task id | — | — |
| `delegate_escrow_auth`() | L1 | admin | admin, config, buffer_pda, delegation_record_pda, delegation_metadata_pda, pda, owner_program, delegation_program, system_program | validator pinned to config.er_validator | — | — |
| `delegate_ledger`() | L1 | anyone (payer) | payer, owner, config, buffer_pda, delegation_record_pda, delegation_metadata_pda, pda, owner_program, delegation_program, system_program | validator pinned to config | — | — |
| `delegate_table`(id) | L1 | admin | admin, config, buffer_pda, delegation_record_pda, delegation_metadata_pda, pda, owner_program, delegation_program, system_program | validator pinned | — | — |
| `deposit`(amount) | L1 | owner | owner, config, user_meta, receipt, mint, owner_ata, vault, token_program, system_program | !paused, amount > 0, receipt PDA init at deposit_count | Deposited | Paused, AmountTooSmall |
| `enter_round`(amount) | ER | owner or session | authority, ledger, table, config, session_token | !paused, !close_only, chip bounds, per-player cap, 32 players, session cap+expiry+SessionTokenV2 | Entered | RoundClosed, PlayerCapExceeded, TableFull, SessionCapExceeded |
| `faucet`() | L1 | owner | owner, config, user_meta, mint, mint_auth, owner_ata, token_program, associated_token_program, system_program | 100 dUSDC, ≥ 6 h cooldown, lifetime cap 1,000 | — | FaucetCooldown, FaucetCapReached |
| `finalize_withdraw`(owner, nonce) | L1 | anyone (rescuer pays rent) | rescuer, config, ledger, owner_account, receipt, owner_ata, mint, vault, vault_auth, token_program, associated_token_program, system_program | same committed-ledger checks; receipt init (fails if paid); pays OWNER's ATA | WithdrawPaid{path:Rescue} | InvalidLedger, NotPending, ConstraintTokenOwner |
| `ingest_deposit`(nonce) | ER | anyone | ledger, receipt | n == ingested_count; receipt PDA/owner/discriminator | DepositIngested | OutOfOrder, InvalidReceipt |
| `init_user`() | L1 | owner | owner, user_meta, ledger, system_program | PDA init (UserMeta, Ledger) | — | — |
| `initialize_config`(params) | L1 | admin | admin, config, mint, mint_auth, vault, vault_auth, token_program, system_program | param bounds (fee ≤ 10%, void > 120 s), PDA mint/vault authorities | — | InvalidConfig |
| `initialize_escrow_and_treasury`(fee_payer_lamports) | L1 | admin | admin, config, escrow_auth, treasury_ledger, system_program | config.admin; pre-funds fee payer | — | — |
| `leave_solo`() | ER | owner or session | authority, ledger, table, session_token | only entrant; Open | SoloLeft | NotSolo |
| `process_undelegation`(account_seeds) | L1 | delegation program | base_account, buffer, payer, system_program | injected by #[ephemeral] | — | — |
| `propose_admin`(new_admin) | L1 | admin | admin, config | two-step rotation | — | — |
| `request_commit`() | ER | anyone | ledger, config, escrow_auth, magic_fee_vault, magic_program, magic_context | oldest Pending ≥ 5 s old (anti fee-burn) | CommitForced | NothingPending, CommitTooEarly |
| `request_withdraw`(amount, inject_fault) | ER | owner or session | authority, ledger, config, session_token, escrow_auth, magic_fee_vault, program, magic_program, magic_context | ≥ min, ≤ available, ring slot reusable; destination fixed; commit + post-commit action via fee payer | WithdrawRequested | RingFull, InsufficientBalance, FaultLabDisabled |
| `retry_vrf`() | ER | anyone | table, oracle_queue, program_identity, vrf_program, slot_hashes, system_program | AwaitingVrf, ≥ 20 s since last request, < 3 attempts, before void | VrfRetried | RetryTooEarly, RetryExhausted |
| `schedule_crank`() | ER | admin | admin, config, table, oracle_queue, instructions, program, magic_program, program_identity, vrf_program, slot_hashes, system_program | derived task id; close_round with no signer metas | — | — |
| `set_flags`(paused, close_only) | L1 | admin | admin, config | pause/close-only only; cannot block exits | — | Unauthorized |
| `set_session`(signer, cap, expires_ts) | ER | owner | owner, ledger | expiry ≤ 24 h; resets spent | — | InvalidSession |
| `settle_round`(round_id) | ER | anyone | table, winner_ledger, treasury_ledger, config, escrow_auth, magic_fee_vault, magic_program, magic_context | Drawn; winner ledger == entries[winner_idx]; fee exact; commits table | RoundSettled | AlreadySettled, NotDrawn, WrongWinner |
| `settle_withdraw`(owner, nonce) | L1 (action) | DLP-signed escrow | config, ledger, owner_account, receipt, owner_ata, mint, vault, vault_auth, token_program, associated_token_program, system_program, source_program, escrow_auth, escrow | escrow signer == balance PDA of OUR escrow_auth; source_program == crate; committed ledger PDA/owner/discriminator; Pending entry; receipt init; vault ≥ amount | WithdrawPaid{path:Action} | Unauthorized, InvalidLedger, NotPending, VaultInsufficient, InjectedFault (devnet) |
| `void_round`(round_id) | ER | anyone | table | AwaitingVrf ≥ 150 s; every entrant ledger in order; all-or-nothing | RoundVoided | VoidTooEarly, BadRefundAccounts |
| `vrf_callback`(randomness, round_id, vrf_nonce) | ER | scoped VRF identity | vrf_program_identity, table | status/round/nonce must match, else stale no-op | RoundDrawn, StaleCallbackIgnored | — |
<!-- IX-TABLE:END -->

## Transaction routing

| Operation | Connection |
|---|---|
| init, faucet, deposit, delegate, rescue (`finalize_withdraw`), session token creation | Solana devnet (via `/api/rpc` proxy in the browser) |
| enter, cash-out request, ingest, ack, close/retry/void/settle, set_session, request_commit | `devnet-eu.magicblock.app` (ER) |
| Post-commit `settle_withdraw` | executed on L1 by the MagicBlock committor |
| VRF callback | executed in the ER by the VRF oracle |
