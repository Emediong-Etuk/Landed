# Landed — every win lands.

**A MagicBlock Ephemeral Rollup jackpot game whose cash-outs are exactly-once and never lost, even when the post-commit Magic Action that pays them out is silently dropped.**

Solana Blitz v10 (MagicBlock) · Entertainment Finance · Ephemeral Rollups + VRF + Magic Actions + Cranks + Session Keys

- Live site: _deploy target Vercel (`app/`); link added once deployed_
- Pitch video (≤ 3:00): _slot ready on `/watch`; script in [docs/VIDEO_SCRIPTS.md](docs/VIDEO_SCRIPTS.md)_
- Technical walkthrough: _slot ready on `/watch`_

> **Status (2026-11-25):** the programs, protocol, tests, verifier, SDK, keeper and site are complete and green locally (106 automated tests, see below). **Devnet deployment is blocked on devnet SOL**: the public RPC faucet now returns `410 The RPC faucet is closed`, so the deployer `452WSNd22LPjnuedzyrygtgjvYs66HtFNSJdZL5685UG` must be funded via faucet.solana.com. Every devnet number in this README is therefore marked *not measured yet* rather than invented. One command deploys, initializes and runs the campaigns once funded (see [Deploy](#deploy-to-devnet)).

---

## 1. The problem

> On MagicBlock, a jackpot round settles in ~10 ms inside the Ephemeral Rollup, but the cash-out to Solana rides a post-commit Magic Action that is not atomic with the commit — when the action fails, the validator drops it and re-commits without it, so one failed action means 100% of that withdrawal is debited in the rollup and 0% reaches the player's wallet, with no error the player ever sees.

| ID | Silent failure (only on this stack) | Landed's fix |
|---|---|---|
| F1 | Post-commit payout action fails → dropped, commit lands without it | Exactly-once withdrawal + permissionless rescue |
| F2 | Without a fee payer, commit 11 fails with `0xA0000000` | Delegated fee-payer PDA + `magic_fee_vault` (30+ cash-outs/session) |
| F3 | VRF callbacks have no age limit; unfulfilled requests are purged after ~120 s | Nonce state machine: retry (old callbacks become no-ops), void + full refund after 150 s |
| F4 | A crank schedule can be accepted and never run (1.1.1 ID collisions; 2.0 needs a Hydra cranker) | Derived task IDs + permissionless watchdog (page + keeper) |
| F5 | `#[action]` handlers and cranked instructions are publicly callable | Escrow-signer pinning + source-program check; every crankable ix time/state-checked |
| F6 | Accounts > 10,240 B can't be committed/undelegated | Fixed-size rings + compile-time asserts (Ledger 601 B, Table 3,848 B) |
| F7 | Two truths: L1 copy is stale until a commit | UI shows rollup / wallet / on-the-way; verifier reconciles both layers |

## 2. Why only MagicBlock

On plain Solana, "debit the balance" and "transfer the tokens" are one atomic transaction. On MagicBlock the game state lives in the rollup and the money on Solana, joined by a commit plus a *separate* action, and a failed action is removed while the commit still lands. The recommended "base-layer custody + post-commit payout" pattern is exactly the one that strands funds.

## 3. The solution

- **Record before paying:** `request_withdraw` (ER) debits, writes `{nonce, amount, Pending}` into a 16-slot ring, commits the ledger and schedules `settle_withdraw`.
- **Pay only from committed state:** the L1 payout reads the *committed* ledger; amount and destination never come from arguments.
- **Exactly once:** paying `init`s the unique `WithdrawReceipt[owner, nonce]`; the action and any rescue can race, and exactly one wins.
- **Never lost:** anyone can call `finalize_withdraw` (pays the **owner**), or `request_commit` first if the commit is missing. The page does it after 8 s.
- **Never overwritten:** ring slots are reused only after `ack_withdrawal` sees the receipt.
- **Exits can't be blocked:** pause stops entries and deposits, never withdrawals or rescues; the admin has no vault path.

Architecture, accounts, round lifecycle and the full instruction table: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Reusable recipe: [docs/SETTLEMENT_PATTERN.md](docs/SETTLEMENT_PATTERN.md).

## 4. Results

| | Metric | Measured |
|---|---|---|
| M1 | Withdrawals with injected action failures | MagicSVM: rescued, 0 lost (`f1_…`). **Devnet: not measured yet** (`pnpm campaign c3`) |
| M2 | Dropped action → paid via rescue | **Devnet: not measured yet** |
| M3 | Cash-outs in one delegation session | **30/30** in MagicSVM; devnet not measured yet (`pnpm campaign c4`) |
| M4 | Stale VRF callbacks rejected / voided rounds refunded | **100% / 100%** in MagicSVM (V2, V3, V4 incl. 32 entrants) |
| M5 | Rounds closed by crank vs watchdog | devnet not measured yet |
| M6 | ER entry confirmation latency | devnet not measured yet |
| M7 | Invariants I1–I6 | hold after every round of a 60-round MagicSVM run; verifier flags all 9 tampered datasets |

Also measured: winner-selection fairness, 200,000 draws → χ² = 3.19 (critical 15.09 at p = 0.01). Live table: [docs/EVIDENCE.md](docs/EVIDENCE.md) (generated, never hand-edited).

## 5. Try it

**(a) Zero setup:** open the site → **Play as guest** (burner wallet, gas, 100 dUSDC, zero signatures) → drop chips → cash out → watch it land. *(Requires the devnet deployment.)*

**(b) Verify from your terminal (no keys):**
```bash
git clone https://github.com/emediong-etuk/landed && cd landed
```
```bash
pnpm i && pnpm verify:devnet
```
Exit code 0 = all invariants hold, 1 = violation, 2 = couldn't fetch (today: 2, program not yet deployed).

**(c) Full local stack + tests.** Prerequisites: Rust (stable), Solana 3.1.9, Anchor CLI 1.0.2 (`npm i -g @anchor-lang/cli@1.0.2`), Node ≥ 22, pnpm 10.
```bash
pnpm i
```
```bash
pnpm build:programs
```
```bash
pnpm test:all
```
```bash
pnpm --filter @landed/app build && pnpm dev
```
Program tests run on **MagicSVM** (real Delegation + Magic programs, post-commit actions, VRF callbacks, cranks, in-process, ~1 min). No local validator needed.

## 6. Deployed addresses (devnet)

Program IDs are fixed by `declare_id!`; everything else is written to [`deployments/devnet.json`](deployments/) by `pnpm init:devnet`.

| | Address |
|---|---|
| `landed` program | `37AZMxLPm9RY8AKQk4s4oMJaovpRorGQfUmMUbTxiqGq` (not yet deployed) |
| `naive_cashout` baseline | `BrHd4kAtkATdaJYcv5GtyQ6ebNUneBV2yqe24EPRtxBc` (not yet deployed) |
| ER validator | devnet-eu `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` (validator 2.0, `core 2.0.5`) |
| Magic fee vault (EU) | `ByZyZ6322wnM48vn1kVdrsGRLjiLU15t2gJUBdXL4MQb` (exists on devnet) |
| Config / mint / vault / table / fee payer / escrow / crank task ID | derived PDAs, see `deployments/devnet.json` after init |

## 7. Proof of deployment

After `pnpm campaign all`, `/proof` and [docs/EVIDENCE.md](docs/EVIDENCE.md) list the featured transactions (delegation, ER entry, VRF request + callback, settle/commit, Magic Action payout, rescue, receipt) with explorer links, all taken from `evidence/ledger.jsonl`.

## 8. MagicBlock features used

| Feature | How | Code |
|---|---|---|
| Ephemeral Rollups + delegation | ledgers, table, fee payer delegated to devnet-eu; free ~ms ER txs | `delegate_*`, `#[delegate]` |
| Commits (`MagicIntentBundleBuilder`) | ledger commit per cash-out; table commit per settled round | `request_withdraw`, `settle_round`, `request_commit` |
| Magic Actions | post-commit `settle_withdraw` with pinned escrow signer | `SettleWithdraw` |
| Fee payer + `magic_fee_vault` | delegated `["escrow_auth"]` PDA pays commits past the 10-commit cap | `build_and_invoke_signed` |
| VRF | scoped identity, ephemeral queue, table PDA as payer, nonce state machine | `close_round`, `vrf_callback` |
| Cranks | `ScheduleTask` tick with derived task ID; watchdog for 2.0/Hydra | `schedule_crank` |
| Session Keys | `SessionTokenV2` + our on-chain spend cap/expiry | `authorize`, `set_session` |

## 9. Security

Threat model (asset · threat · mitigation · where · test) and audit checklist: [docs/SECURITY.md](docs/SECURITY.md). Trust assumptions: the ER validator eventually commits; the VRF oracle eventually delivers.

## 10. Testing

| Layer | Passed |
|---|---|
| landed-core unit + property + fairness | 21/21 |
| program unit | 3/3 |
| program integration on MagicSVM (A1–A27, V1–V4, F1, F2, crank, 60 rounds) | 35/35 |
| SDK golden vectors / decoders / tracker | 14/14 |
| verifier tamper fixtures | 10/10 |
| app unit | 4/4 |
| web E2E + axe (desktop + mobile) | 19/19 |

Details, per-ID results and the bugs we found along the way: [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

## 11. Honest limitations

- **Not on devnet yet** (unfunded deployer; see status above). Nothing live is claimed.
- ER validator liveness: if it never commits, a rescue waits. Landed removes the *action* as a single point of failure, not the validator.
- VRF oracle liveness: we verify provenance and handle delay (retry/void) but can't force delivery.
- Validator 2.0 runs cranks through Hydra; if no cranker runs on devnet, the watchdog closes rounds (the Proof page shows the split).
- Devnet only, test token, no real money; a real launch needs legal/licensing review and responsible-gaming controls.
- Guest burner keys live in the browser (encrypted at rest; XSS remains a risk class). Bots are ours and labeled. House fees stay in the treasury ledger (no admin withdrawal by design).
- Not using Private ERs: privacy doesn't fix settlement correctness.

## 12. Reuse the pattern

[docs/SETTLEMENT_PATTERN.md](docs/SETTLEMENT_PATTERN.md): five rules plus a checklist to make your game's payouts exactly-once and rescuable.

---

### Deploy to devnet

Fund the deployer at https://faucet.solana.com (≈ 12 devnet SOL: ~5 SOL program rent for `landed` (712 KB) + ~2.5 SOL for the baseline, a temporary deploy buffer, and the campaigns). Then:

```bash
pnpm build:programs && pnpm deploy:devnet && pnpm init:devnet
```
```bash
pnpm campaign all && pnpm verify:devnet && pnpm evidence:summarize
```

Repo map: `programs/` (Anchor), `crates/landed-core`, `packages/{sdk,verifier}`, `app/` (Next.js), `services/keeper`, `tests/{magicsvm,devnet}`, `scripts/`, `docs/`, `evidence/`. Decisions and doc discrepancies: [docs/DECISIONS.md](docs/DECISIONS.md).
