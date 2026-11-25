# Phase 0 findings

Status on 2026-11-25: **the devnet spikes are written but not yet run.** The deployer wallet (`452WSNd22LPjnuedzyrygtgjvYs66HtFNSJdZL5685UG`) has 0 devnet SOL and the public RPC faucet returns `410 The RPC faucet is closed on this cluster`. Each spike below states what is already established (live endpoint probes, the MagicBlock dev skill's source-verified notes, and MagicSVM runs of the real Delegation/Magic programs) and the exact command that produces the devnet evidence. Results land in `evidence/results/<id>.json` and are summarized into `docs/EVIDENCE.md` automatically. Nothing below is a devnet measurement unless it says so.

## Live probes already done (2026-11-25)

| Probe | Result |
|---|---|
| `getVersion` devnet-eu / -us / -as | `core 2.0.5` (`380360a`) on all three: **validator 2.0**, not 1.1.1 (`evidence/raw/er-version-2026-11-25.json`) |
| `getIdentity` devnet-eu | `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` |
| magic fee vault for MEUGG (`ByZyZ6322wnM48vn1kVdrsGRLjiLU15t2gJUBdXL4MQb`) | exists on L1, owned by the delegation program, 17.77 SOL, 8 bytes |
| Ephemeral VRF queue `5hBR57…` | delegated; visible in the ER, owned by `Vrf1RN…` (9,500 bytes) |
| Hydra ephemeral `eHyd5B…`, session-keys `KeyspM…`, VRF `Vrf1RN…` | executable on both L1 and the ER |

## Spikes

| ID | Question | Established so far | Devnet command |
|---|---|---|---|
| **S1** | What happens when a post-commit action fails? | Dev skill (source-verified): each attempt is atomic; on a BaseAction failure the committor **removes the actions and retries the commit** → the commit lands without the payout (F1). MagicSVM instead reverts the whole ER transaction (`s1_reverted_outcome_debits_nothing`). Landed is correct under all three outcomes: dropped (rescue), reverted (nothing debited), stuck (`request_commit` then rescue). | `pnpm campaign s1` (5 faulted + 1 clean withdrawal, records commit/receipt/L1 sigs) |
| **S2** | How fast does the ER see a fresh L1 account? | MagicSVM mirrors read-only accounts from base on each tx. Design uses receipt-ingest with automatic retries (`LandedClient.ingestAll`); fallback B not needed unless S2 fails. | `pnpm campaign s2 --n 20` |
| **S3** | Commit cap without / with fee payer | Dev skill: commit 11 fails with `0xA0000000` without the fee-vault path (2.0 counts queued commits); with a delegated payer commits 1–25 add no live fee, then 1,000,000 lamports per account. MagicSVM: 30 cash-outs in one session succeed (`f2_thirty_cashouts_in_one_delegation_session`; MagicSVM doesn't model the cap). | `pnpm campaign c4` (30 Landed + 11 naive, the naive baseline uses the player as payer) |
| **S4** | Funding the action escrow for a PDA `escrow_auth` | DLP `TopUpEphemeralBalance` with `escrow_auth = ["escrow_auth"]` funds `["balance", escrow_auth, 255]`; the action pays receipt + ATA rent from it. **Verified in MagicSVM** (every `settle_withdraw` in the suite creates its receipt with escrow rent). | covered by `pnpm init:devnet` + any cash-out |
| **S5** | VRF inside the ER | The delegated table PDA can sign as VRF payer (ephemeral queue is fee-exempt). Verified in MagicSVM (V1–V4, 60-round run). Found and fixed two SDK compute traps (see DECISIONS). | `pnpm campaign s5 --n 30` |
| **S6** | Cranks | Validator 2.0 forwards `ScheduleTask` to Hydra; tasks only fire if a `hydra-cranker` runs. MagicSVM (1.1.1 model) runs our schedule and closes rounds (`crank_schedules_and_closes_rounds`). The watchdog covers a silent crank. | `pnpm init:devnet` schedules it; `c2` reports crank vs watchdog closes |
| **S7** | Session keys in the ER | Gasless example: an ER fee payer may hold 0 SOL. MagicSVM covers our cap/expiry/V2 checks (`a7_a8_a9_a10_session_rules`). | `pnpm campaign s7` |
| **S8** | Reading committed data on L1 | MagicSVM: the committed L1 ledger (owner = delegation program) deserializes and matches the ER (`withdraw_happy_path…`, `f1_…`); the rescue path depends on it. | `pnpm campaign s8` |

## Decision gates

- **S1**: any outcome is handled (see `docs/DECISIONS.md`). If devnet shows "reverted & stuck", the UI already calls `request_commit` automatically after 8 s.
- **S2**: if the ER does not see fresh receipts within ~5 s, switch deposits to fallback B (commit-and-undelegate → L1 credit → re-delegate). Not implemented unless S2 demands it.
- **S7**: confirmed by documentation; verified on devnet by `s7`.
