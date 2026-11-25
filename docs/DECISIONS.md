# Decisions log

Format: **date · decision** — alternatives · why. Where the build prompt disagreed with the live MagicBlock docs, the dev skill (v0.5.1, checked 2026-11-24) or a live endpoint, the live source wins and the discrepancy is recorded here.

---

### 2026-11-25 · Target validator: `devnet-eu` runs validator **2.0** (`core 2.0.5`), not 1.1.1
- Alternatives: devnet-tee (1.1.1, but a TEE/private ER, which we deliberately don't use); mainnet ERs (1.1.1, real money).
- Why: `getVersion` on `https://devnet-eu.magicblock.app` returned `{"core":"2.0.5","solana-core":"4.2.2","git-commit":"380360a"}` on 2026-11-25. The prompt assumed 1.1.1. All three regional devnet ERs moved to 2.0 (dev skill, 2026-11-24). We stay on devnet-eu (closest to West Africa) and adapt to 2.0 semantics below. Evidence: `evidence/raw/er-version-2026-11-25.json`.

### 2026-11-25 · SDK pin: `ephemeral-rollups-sdk = "=0.18.0"` (Rust) with features `anchor, vrf, crank`
- Alternatives: 0.20.x (the 2.0 line).
- Why: 0.20.0's `#[vrf]` fails to compile (`E0433 slot_hashes`). 0.18.x supports validator 1.x **and** 2.0 (dev skill "SDK lines"). TS side: `@magicblock-labs/ephemeral-rollups-sdk` npm dist-tag `legacy` (0.18.x), since 0.18 reads both 1.x and 2.0 commit logs.

### 2026-11-25 · Cranks on validator 2.0 run through **Hydra**; F4 changes shape
- Prompt said: task IDs collide globally on 1.1.1 and a colliding schedule silently never runs.
- Live: on 2.0, `ScheduleTask` is forwarded to a `hydra-ephemeral` crank whose PDA hashes `(task_authority, task_id)`, so IDs are namespaced per authority (no cross-program collision). **But** tasks fire only while a `hydra-cranker` process runs, and whether MagicBlock runs one for devnet 2.0 ERs is unconfirmed. Signer metas in scheduled instructions are rejected.
- Decision: still derive the task ID (`sha256("landed-crank" ‖ program ‖ table)`, works on 1.x too), keep `close_round` fully permissionless and signer-free, and keep the **watchdog** (UI + keeper) as the liveness guarantee. F4 is reframed as "a crank schedule that is accepted but never executes" (no cranker / collision on 1.x). The keeper can also run `hydra-cranker`. `closed_by` = Crank only when the instructions sysvar shows a Hydra `Trigger` right before `close_round` (honest telemetry, not self-reported).

### 2026-11-25 · VRF payer for signer-less crank ticks = the delegated Table PDA
- Alternatives: a separate signer-only `request_draw` instruction after a crank "lock".
- Why: `invoke_signed_vrf` signs only the program identity; the payer meta must be a signer, and Hydra scheduled instructions cannot carry signers. The Table PDA is delegated and writable in the ER, so `close_round` signs for it with `invoke_signed` (table seeds + identity seeds). The ephemeral queue is fee-exempt, so no lamports move from the table. Verified in MagicSVM; to be verified on devnet (spike S5).

### 2026-11-25 · Magic Action failure semantics (S1), as documented today
- Prompt cited a docs conflict ("dropped and re-committed" vs troubleshooting "any action failure reverts the commit").
- Dev skill (source-verified): *each attempted base transaction applies commit + actions atomically; if any BaseAction fails, the committor removes every BaseAction in that TransactionStrategy and retries the remaining commit.* So the observable outcome is **reverted-and-retried-without-action** = commit lands, payout never happens: the F1 failure. Phase 0 S1 measures this on devnet; the design is correct under all three outcomes (dropped, reverted+retried, reverted+stuck) because the rescue reads the committed ledger and `request_commit` covers "stuck".

### 2026-11-25 · Commit economics on 2.0
- Without a delegated fee payer, commit 11 fails with `0xA0000000` (2.0 counts *queued* commits, so this triggers even when commits are sent fast). With delegated payer + validator-scoped `magic_fee_vault`, commits 1–25 add no live fee; from commit 26 each committed account costs **1,000,000 lamports** (prompt said 100,000; that was the v1.1.1 tag). Delegation deposit ≈ 2.8M–3.3M lamports per delegated account, session fee 3M. Recorded in EVIDENCE.md once measured.
- Decision: one PDA `["escrow_auth"]` is **both** the delegated intent payer (fee-vault path) and the Magic Action escrow authority. `settle_withdraw` binds `escrow_auth` to that PDA and pins `escrow` to `ephemeral_balance_pda_from_payer(escrow_auth, 255)` + signer + `source_program == crate::ID`.

### 2026-11-25 · Lamports top-up setup charge on devnet = 3,000,000 lamports (prompt: 300,000)
- Source: dev skill lamports-topup (eSPL #161). For the fee payer we therefore pre-fund it with plain SOL **before** delegation (in `initialize_escrow_and_treasury`) and only use `lamportsDelegatedTransferIx` for later top-ups.

### 2026-11-25 · Round with < 2 players: extend instead of refund-and-reopen
- Prompt: "< 2 distinct players → refund entries, reopen (no VRF)".
- Why: `close_round` is crankable, and crank instructions have a fixed account list, so it cannot carry the player's ledger to refund it. Instead the round is **extended** by `round_secs` (no VRF, no state lost) and a lone player can call `leave_solo` at any time to take their chips back. The labeled bots make solo rounds rare.

### 2026-11-25 · `close_round` / tick returns Ok (no-op) when not due
- Prompt A26: "crankable ixs called early → rejected, no state change".
- Why: on 2.0 a failing scheduled instruction fails the cranker's whole `Trigger` transaction and the schedule doesn't advance, which would retry every slot. A no-op success is safer for the crank and still leaves state untouched (A26 asserts "no state change"). Every *non*-crankable permissionless instruction (retry, void, settle, rescue, ack, ingest, request_commit) rejects early calls with an error.

### 2026-11-25 · The crank tick also performs VRF retry
- `close_round` advances Open→AwaitingVrf when due, and AwaitingVrf→(new nonce) when a retry is due. Void needs every entrant's ledger, so it stays a separate permissionless instruction (UI/keeper call it).

### 2026-11-25 · Table is zero-copy; Ledger is Borsh
- Table ≈ 3.7 KB would be deserialized onto the 4 KB SBF stack by `Account<T>`. Zero-copy keeps it in account memory; explicit `_pad` fields so the byte layout equals the Borsh layout (TS decoding via IDL stays simple). Ledger (~600 B) stays Borsh so L1 rescue code can `try_deserialize` it from an `UncheckedAccount`.

### 2026-11-25 · Session keys: our ledger grant + MagicBlock `SessionTokenV2`, both required
- The session-keys program enforces no spend limits, so the owner records `{signer, cap, expires}` in their ledger via `set_session` (ER), and every session-signed `enter_round`/`request_withdraw`/`leave_solo` must also present a valid `SessionTokenV2` (authority = owner, target = this program, not expired). Withdrawals always go to the owner's ATA, so a stolen session key can at most play within its cap. V1 tokens are rejected by type (`Account<SessionTokenV2>`). Guests don't need sessions: their burner is the owner.

### 2026-11-25 · Treasury fees stay in the treasury ledger
- Prompt: treasury withdraws through the same protocol.
- Why: the admin must never be able to move vault funds. The treasury ledger is a normal ledger owned by the `["treasury"]` PDA and is counted in I2; there is no instruction that withdraws it. Documented as a limitation (a real launch would add a governed treasury withdrawal through `request_withdraw` to a fixed treasury ATA).

### 2026-11-25 · No faucet on the RPC: devnet SOL must be supplied by the user
- `requestAirdrop` on api.devnet.solana.com returns `410 The RPC faucet is closed on this cluster`. Devnet SOL has to come from faucet.solana.com (GitHub login) or a transfer. Until the deployer wallet is funded, every devnet step is blocked and reported as such; nothing is faked.

### 2026-11-25 · MagicSVM 0.3.0 for program tests instead of a local `mb-stack`
- MagicSVM runs the real Delegation Program and Magic program in-process: delegation, commits, post-commit actions, VRF callbacks and 1.1.1-style cranks. That covers A1–A27 and V1–V4 deterministically. Live behaviors it doesn't model (2.0/Hydra, the real oracle, commit limits, fees) are covered by devnet spikes and campaigns.

### 2026-11-25 · Anchor derive crates pinned to 1.0.2 in Cargo.lock
- `session-keys` resolves `anchor-derive-*` 1.2.2, which references `create_account_allow_prefund` missing in anchor-lang 1.0.2. Pinned all `anchor-attribute-*`, `anchor-derive-*` and `anchor-syn` to `=1.0.2` with `cargo update --precise`.

### 2026-11-25 · Two SDK compute pitfalls found by MagicSVM (each burned the full 200k CU)
1. `program_identity_pubkey(&crate::ID)` is a `const fn`; called in a normal expression it runs a software PDA search at runtime. Fixed by using the `const VRF_IDENTITY` item.
2. `#[vrf_callback]`'s injected constraint is `address = Pubkey::new_from_array(scoped_vrf_identity_const(&crate::ID).0)`, which is also evaluated at runtime (software ed25519 PDA derivation) → every VRF callback ran out of compute. The macro skips injection when the struct already declares `vrf_program_identity`, so we declare it ourselves against `pub const VRF_CALLBACK_IDENTITY` (compile-time). Same security (scoped identity signer), ~190k CU cheaper. Worth upstreaming.

### 2026-11-25 · MagicSVM runs post-commit actions synchronously; test build reproduces the live committor
- In MagicSVM 0.3.0 a failing post-commit action fails the whole ER transaction (nothing debited): that is the "reverted & stuck" outcome, and test `s1_reverted_outcome_debits_nothing` covers it. The live committor instead removes failed actions and re-commits (dev skill), which is F1. The test-only feature `sim-committor-drop` (MagicSVM build `landed_test.so` only, never deployed) makes a fault-injected withdrawal commit **without** its action, i.e. the live outcome, so the rescue path is tested in-process. The real behavior is measured on devnet (S1, C3).

### 2026-11-25 · `void_round` uses the ledger's stored bump (`create_program_address`) and clients add a 1.4M CU limit
- 32 entrant refunds in one ER transaction passed in MagicSVM (V4) with `SetComputeUnitLimit(1_400_000)`. No batching was needed.
