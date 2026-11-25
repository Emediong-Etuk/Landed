# Video scripts

B-roll: `pnpm record:broll` (Playwright, 1080p, `?demo=1` mode) writes clips to `evidence/broll/`. Numbers in square brackets come from `docs/EVIDENCE.md` at recording time. **Read them from that file; never improvise a number.**

---

## Video 1 — Pitch (hard limit 3:00): user, problem, demo

| Time | Shot | Words (voice-over) |
|---|---|---|
| 0:00–0:12 | `broll/02-drop-reveal.webm`: the needle lands on "You!", confetti. Cut to a wallet showing 0.00. | "You won. The game says so. … Did you get paid?" |
| 0:12–0:25 | Still of Ada's phone mock on `/play`. | "This is Ada. She's 24, in Lagos, and plays 20-second pot rounds between classes. She doesn't care what a commit is. She cares that a win becomes tokens in her wallet." |
| 0:25–0:40 | `/how-it-works` two-truths animation; red dot falls. | "On MagicBlock, a round settles in about ten milliseconds inside the Ephemeral Rollup. But the cash-out to Solana rides a post-commit Magic Action that isn't atomic with the commit. When that action fails, the validator drops it and commits anyway. One hundred percent of the withdrawal is debited in the rollup, zero percent reaches the wallet, and nobody sees an error. That can only happen on this stack." |
| 0:40–1:00 | `broll/01-guest-onboarding.webm` | "Landed fixes it. One click: Play as guest. A burner wallet, a little gas, a hundred test dollars. No wallet popup, no seed phrase." |
| 1:00–1:35 | `broll/02-drop-reveal.webm` | "Drop chips: one tap, zero fees, ten-ish milliseconds. When the round closes, MagicBlock VRF picks a winner weighted by stake. The needle's angle comes from the on-chain randomness, so anyone can replay it." |
| 1:35–1:55 | `broll/03-cashout-lands.webm` | "Cash out. Requested in the rollup, committed to Solana, paid, with a receipt. In seconds." |
| 1:55–2:15 | `broll/04-fault-lab.webm` | "Now we break it on purpose. Same failing payout, two programs. The documented pattern: debited, committed, never paid, and nothing anyone can call. Landed: the payout was recorded before it was paid, so it's rescued, by the page, our keeper, or any stranger, straight to Ada's wallet. Exactly once." |
| 2:15–2:25 | `broll/05-verify.webm` | "And you don't have to trust us. The verifier recomputes every round and reconciles every payout from chain data, in your browser." |
| 2:25–2:50 | `/proof` metrics table | "On devnet: [M1: Landed 0 lost out of N withdrawals with injected failures; naive k of k stranded]. Rescues landed in [M2 p50] seconds. [M3] cash-outs in one session, past the ten-commit cap." |
| 2:50–3:00 | Landing hero | "Landed. Every win lands. landed dot [domain]." |

---

## Video 2 — Technical walkthrough (target 4–5 min; cut points marked ✂ to reach 3:00)

1. **Architecture (0:00–0:50).** `docs/ARCHITECTURE.md` diagram. "Custody on Solana: dUSDC vault, deposit and withdraw receipts. Game state in the ER: per-player ledgers and the table, all under 10,240 bytes with compile-time asserts, so they can always be committed and undelegated." ✂ cut the account table if over time.
2. **Settlement protocol (0:50–2:00).** Walk `request_withdraw` → commit + `settle_withdraw` action → `finalize_withdraw` → `ack_withdrawal`. "Amounts and destinations only come from the committed ledger. Payment requires initializing a unique receipt PDA, so the action and a rescue can race and exactly one wins. Unpaid ring slots can't be overwritten." Show Phase 0 S1: "[S1 outcome from EVIDENCE.md]."
3. **Explorer walkthrough (2:00–3:10).** From `/proof` → Featured transactions: delegation tx → ER entry → close_round (VRF request) → VRF callback (via VRF program) → settle_round (table commit) → request_withdraw (commit + action) → injected fault → finalize_withdraw (rescue) → receipt. ✂ skip the delegation and settle steps.
4. **Safety (3:10–3:50).** Escrow-signer pinning (A1/A2), session caps + SessionTokenV2 (A7–A10), stale-callback handling (V2), crank watchdog and why it matters on validator 2.0/Hydra (F4), and the two SDK compute traps we found (DECISIONS).
5. **Tests (3:50–4:30).** `docs/TEST_REPORT.md` summary table; MagicSVM suite run; verifier on Landed (pass) vs naive (N1 stranded). ✂ keep only the summary table.
6. **Limitations (4:30–4:50).** Validator/oracle liveness trust, devnet only, burner keys in browser, bots are ours.

---

## B-roll shot list (`pnpm record:broll`)

| File | Flow |
|---|---|
| `01-guest-onboarding.webm` | `/` → Play as guest → progress 1/3…3/3 → drop buttons enabled |
| `02-drop-reveal.webm` | drops 5 and 10 → countdown → Drawing → needle lands |
| `03-cashout-lands.webm` | Cash out all → Settlement Rail to Paid (technical details on) |
| `04-fault-lab.webm` | `/lab` → open baseline → failing payout → naive stranded vs Landed rescued |
| `05-verify.webm` | `/verify` all green |
| `06-proof.webm` | `/proof` scroll |
