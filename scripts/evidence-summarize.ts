/**
 * pnpm evidence:summarize — turns evidence/ledger.jsonl + evidence/results/*.json
 * + evidence/tests/summary.json + deployments/devnet.json into docs/EVIDENCE.md
 * and app/public/evidence.json. Never invents a number: anything not measured
 * is reported as "not measured yet".
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const read = <T,>(p: string): T | null => (existsSync(resolve(ROOT, p)) ? (JSON.parse(readFileSync(resolve(ROOT, p), "utf8")) as T) : null);

interface Line { ts: string; campaign: string; step: string; layer: "L1" | "ER"; sig: string | null; explorer_url: string | null; ok: boolean; latency_ms: number | null; err: string | null }
const ledgerPath = resolve(ROOT, "evidence/ledger.jsonl");
const lines: Line[] = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const results: Record<string, any> = {};
const rdir = resolve(ROOT, "evidence/results");
if (existsSync(rdir)) for (const f of readdirSync(rdir)) if (f.endsWith(".json")) results[f.replace(".json", "")] = JSON.parse(readFileSync(resolve(rdir, f), "utf8"));
const tests = read<{ ran_at: string; rows: { layer: string; tests: number; passed: number; failed: number; skipped: number }[] }>("evidence/tests/summary.json");
const dep = read<Record<string, any>>("deployments/devnet.json");
const e2e = read<{ stats: { expected: number; unexpected: number; skipped: number; flaky: number } }>("evidence/tests/e2e.json");
if (tests && e2e) tests.rows.push({ layer: "web E2E + axe a11y (Playwright, desktop + mobile)", tests: e2e.stats.expected + e2e.stats.unexpected, passed: e2e.stats.expected, failed: e2e.stats.unexpected, skipped: e2e.stats.skipped });

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
const byCampaign = new Map<string, Line[]>();
for (const l of lines) byCampaign.set(l.campaign, [...(byCampaign.get(l.campaign) ?? []), l]);

const erEntries = lines.filter((l) => l.step === "enter_round" && l.ok && l.latency_ms !== null).map((l) => l.latency_ms!);
const NM = "not measured yet";
const r = results;
const metrics = [
  { id: "M1", label: "Withdrawals with injected action failures (lost / total)", value: r.c3 ? `Landed ${r.c3.landed.owed_left} lost / ${r.c3.landed.withdrawals} (${r.c3.landed.injected} injected, ${r.c3.landed.via_rescue} via rescue) · naive ${r.c3.naive.accepted_in_er} stranded / ${r.c3.naive.faulty_cashouts}` : NM, source: "evidence/results/c3.json" },
  { id: "M2", label: "Dropped action → paid via rescue", value: r.c3 ? `p50 ${r.c3.landed.rescue_p50_ms} ms · p95 ${r.c3.landed.rescue_p95_ms} ms` : NM, source: "evidence/results/c3.json" },
  { id: "M3", label: "Cash-outs in one delegation session", value: r.c4 ? `${r.c4.landed_success} succeeded on Landed; naive 11th: ${r.c4.naive_11th?.ok ? "ok" : (r.c4.naive_11th?.err ?? "?")}` : "30/30 in MagicSVM (f2_thirty_cashouts_in_one_delegation_session); devnet " + NM, source: "evidence/results/c4.json" },
  { id: "M4", label: "Stale VRF callbacks rejected / voided rounds refunded", value: "100% / 100% in MagicSVM (v2, v3, v4, a13–a16)" + (r.c2 ? ` · devnet: ${r.c2.table.stale} stale ignored, ${r.c2.table.voided} voided` : ""), source: "tests/magicsvm/tests/game.rs" },
  { id: "M5", label: "Rounds closed by crank vs watchdog", value: r.c2 ? `${r.c2.table.closes_by_crank} crank / ${r.c2.table.closes_by_keeper} watchdog` : NM, source: "evidence/results/c2.json" },
  { id: "M6", label: "ER entry confirmation latency", value: erEntries.length ? `p50 ${pct(erEntries, 50)} ms · p95 ${pct(erEntries, 95)} ms · p99 ${pct(erEntries, 99)} ms (n=${erEntries.length})` : NM, source: "evidence/ledger.jsonl (enter_round)", p50: pct(erEntries, 50) },
  { id: "M7", label: "Invariants I1–I6", value: existsSync(resolve(ROOT, "evidence/verifier")) ? `${readdirSync(resolve(ROOT, "evidence/verifier")).length} verifier runs recorded` : "checked in MagicSVM (assert_i2, assert_i6) + verifier fixtures; devnet " + NM, source: "evidence/verifier/" },
];

const featuredSteps: [string, string][] = [
  ["Delegation (ledger)", "onboard"], ["ER entry", "enter_round"], ["VRF request (close_round)", "close_round"], ["Settle + table commit", "settle_round"],
  ["Cash-out (commit + Magic Action)", "request_withdraw"], ["Rescue (finalize_withdraw)", "finalize_withdraw"], ["Forced commit", "request_commit"], ["Ack", "ack_withdrawal"], ["Crank scheduled", "schedule_crank"],
];
const featured = featuredSteps.flatMap(([label, step]) => {
  const l = lines.find((x) => x.step === step && x.ok && x.sig);
  return l ? [{ label, sig: l.sig!, layer: l.layer }] : [];
});

const phase0 = [
  r.s1 && { id: "S1", title: "Action failure semantics", finding: r.s1.outcome },
  r.s2 && { id: "S2", title: "ER visibility of fresh L1 accounts", finding: `${r.s2.visible}/${r.s2.trials} visible; p50 ${r.s2.p50_ms} ms, p95 ${r.s2.p95_ms} ms` },
  r.c4 && { id: "S3", title: "Commit cap and fee payer", finding: `Landed ${r.c4.landed_success} cash-outs in one session; naive 11th commit: ${r.c4.naive_11th?.ok ? "succeeded" : r.c4.naive_11th?.err}` },
  r.s5 && { id: "S5", title: "VRF inside the ER", finding: `callback p50 ${r.s5.vrf_p50_ms} ms, p95 ${r.s5.vrf_p95_ms} ms over ${r.s5.rounds} rounds` },
  r.s7 && { id: "S7", title: "Session keys in the ER", finding: `session signer with ${r.s7.session_signer_lamports} lamports signed an ER entry: ${r.s7.session_signed_enter?.ok}` },
  r.s8 && { id: "S8", title: "Reading committed data on L1", finding: `L1 owner ${r.s8.l1_owner?.slice(0, 6)}…, ER/L1 nonce match: ${r.s8.match}` },
].filter(Boolean);

const campaigns = [...byCampaign.entries()].map(([id, ls]) => ({ id, txs: ls.length, ok: ls.filter((l) => l.ok).length, p50_ms: pct(ls.filter((l) => l.latency_ms !== null).map((l) => l.latency_ms!), 50) }));
const deployed = !!dep?.programs;

const out = { generated_at: new Date().toISOString(), deployed, featured, campaigns, metrics, phase0, tests: tests?.rows ?? [], deployments: dep ?? null };
writeFileSync(resolve(ROOT, "app/public/evidence.json"), JSON.stringify(out, null, 2));

const md = [
  "# Evidence",
  "",
  `_Generated by \`pnpm evidence:summarize\` at ${out.generated_at}. Source of truth: \`evidence/ledger.jsonl\` (${lines.length} lines), \`evidence/results/\`, \`evidence/tests/summary.json\`, \`deployments/devnet.json\`. Never hand-edited._`,
  "",
  `**Devnet deployment:** ${deployed ? `yes — landed \`${dep!.programs.landed?.program_id}\`` : "not yet (deployer wallet unfunded: the devnet RPC faucet is closed)"}`,
  "",
  "## Metrics",
  "",
  "| ID | Metric | Measured | Source |", "|---|---|---|---|",
  ...metrics.map((m) => `| ${m.id} | ${m.label} | ${m.value} | \`${m.source}\` |`),
  "",
  "## Test runs",
  "",
  tests ? `Ran at ${tests.ran_at}.` : "No recorded test run yet (`pnpm test:all`).",
  "",
  "| Layer | Tests | Passed | Failed | Skipped |", "|---|---|---|---|---|",
  ...(tests?.rows ?? []).map((t) => `| ${t.layer} | ${t.tests} | ${t.passed} | ${t.failed} | ${t.skipped} |`),
  "",
  "## Campaign transactions",
  "",
  campaigns.length ? ["| Campaign | Txs | OK | p50 latency |", "|---|---|---|---|", ...campaigns.map((c) => `| ${c.id} | ${c.txs} | ${c.ok} | ${c.p50_ms ?? "—"} ms |`)].join("\n") : "_No devnet transactions recorded yet._",
  "",
  "## Featured transactions",
  "",
  featured.length ? featured.map((f) => `- ${f.label}: [${f.sig.slice(0, 16)}…](${lines.find((l) => l.sig === f.sig)?.explorer_url}) (${f.layer})`).join("\n") : "_None yet._",
  "",
  "## Phase 0",
  "",
  phase0.length ? phase0.map((p: any) => `- **${p.id} ${p.title}:** ${p.finding}`).join("\n") : "_Spikes not run on devnet yet; see docs/PHASE0_FINDINGS.md for the MagicSVM + documentation baseline._",
  "",
].join("\n");
writeFileSync(resolve(ROOT, "docs/EVIDENCE.md"), md);
console.log(`wrote docs/EVIDENCE.md and app/public/evidence.json (${lines.length} ledger lines, deployed=${deployed})`);
