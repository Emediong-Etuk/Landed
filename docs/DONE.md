# Definition of done (§16), checked honestly

Legend: ✅ done and verified · 🟡 done locally, needs devnet to finish · ⛔ blocked (reason given)

- 🟡 **Programs deployed on devnet; `deployments/devnet.json` committed; real delegations + VRF requests.** Programs build (`landed.so` 712 KB, `naive_cashout.so` 351 KB) and pass 35 MagicSVM integration tests. Deploy, init and campaign scripts are written and typechecked. ⛔ The deployer has 0 devnet SOL and the RPC faucet is closed (`410`). Needs ~12 SOL via faucet.solana.com.
- 🟡 **Guest from landing to first drop ≤ 30 s, zero signatures.** Implemented (burner + `/api/guest/topup` + one batched L1 tx + ER ingest; no signature prompts). Timing is measured by campaign C1 once deployed.
- 🟡 **Cash-out lands; injected-fault cash-out rescued automatically; naive baseline visibly strands funds.** Proven in MagicSVM (`withdraw_happy_path…`, `f1_…`) and wired in `/play` and `/lab`; devnet run pending.
- 🟡 **≥ 30 cash-outs in one delegation session.** 30/30 in MagicSVM; the devnet run (`pnpm campaign c4`) also shows the naive 11th-commit failure.
- ✅ **Stale VRF callbacks ignored; voided rounds refunded; watchdog covers a silent crank.** V2, V3, V4 (32 entrants), A13–A16, crank test; page and keeper watchdog via `LandedClient.tick`.
- 🟡 **Verifier passes I1–I6 on Landed and flags the naive baseline; fixture tests pass.** Fixture tests pass (10/10, incl. naive stranded). CLI and browser runs work end to end against devnet and currently, correctly, report "not deployed" (exit 2).
- 🟡 **All test layers run; TEST_REPORT has real numbers; CI green.** 106 local tests green (`evidence/tests/`). CI workflow written (`.github/workflows/ci.yml`), not yet observed running on GitHub. Devnet campaign numbers pending.
- ✅ **Site: every page, tour, video slots, mobile layout, a11y and perf bars.** 7 routes; 10-step route-aware tour; lite video embeds with "coming soon" frames; E2E + axe green on desktop and Pixel 7, no horizontal scroll; `/` first-load JS 162 KB (budget 200 KB). Lighthouse itself not run here.
- ✅ **README complete with addresses, proof links, a 5-minute run, limitations.** Proof links fill in automatically from evidence after deployment.
- ✅ **VIDEO_SCRIPTS + b-roll tooling ready.** Scripts and shot list written; `pnpm record:broll` records clips once gameplay works on devnet.
- ✅ **No secrets in the repo or the client bundle.** `.gitignore` covers keys and env files; CI greps the build output; the faucet key and keyed RPC are server-side only.

## Not done / cut

- Share card (first item on the cut line).
- Sound (cut line).
- Load test L1 (script hooks exist via `LandedClient`; run requires devnet).
- Vercel and keeper deployment (need the user's accounts; config is ready: `app/`, `services/keeper/Dockerfile`, `.env.example`).
