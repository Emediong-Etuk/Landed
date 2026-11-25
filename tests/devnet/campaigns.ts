/**
 * Devnet campaigns + Phase 0 spikes (real transactions, all recorded in evidence/ledger.jsonl).
 *   tsx tests/devnet/campaigns.ts <s1|s2|s3|s5|s6|s7|s8|c1|c2|c3|c4|c5|c7|all> [--n N]
 * Results go to evidence/results/<id>.json; docs are generated from those files only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  CLOSED_BY, LandedClient, ONE_DUSDC, SLOT_STATE, TABLE_STATUS, ata, ix, naiveIx, naivePda, pda, sleep,
} from "@landed/sdk";
import { recordEvidence } from "@landed/sdk/evidence";
import { buildReport, fetchSnapshot, reportJson, runAll } from "@landed/verifier";
import { client, fund, loadKeypair, pct, ROOT, wallet } from "./lib";
import { player } from "./players";

const id = process.argv[2] ?? "help";
const N = Number(process.argv[process.argv.indexOf("--n") + 1]) || undefined;
const admin = loadKeypair();
const D = ONE_DUSDC;

function save(name: string, data: unknown) {
  const dir = resolve(ROOT, "evidence/results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${name}.json`), JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`saved evidence/results/${name}.json`);
}

async function verify(tag: string) {
  const c = new LandedClient();
  const snap = await fetchSnapshot({ l1Url: c.l1.rpcEndpoint, erUrl: c.er.rpcEndpoint });
  const rep = buildReport(snap, runAll(snap));
  mkdirSync(resolve(ROOT, "evidence/verifier"), { recursive: true });
  writeFileSync(resolve(ROOT, `evidence/verifier/${tag}.json`), reportJson(rep));
  for (const ch of rep.checks) console.log(`  [${ch.status}] ${ch.id} ${ch.detail}`);
  recordEvidence({ campaign: "C7", step: `verify_${tag}`, layer: "L1", ok: rep.checks.every((x) => x.status !== "fail" || x.id === "N1"), notes: JSON.stringify(rep.summary) });
  return rep;
}

// ------------------------------------------------------------------ Phase 0

/** S1: what happens on devnet when a post-commit action fails? */
async function s1(c: LandedClient) {
  const p = await player(c, admin, "s1-player", 50);
  const trials: unknown[] = [];
  for (let i = 0; i < 6; i++) {
    const fault = i < 5;
    const { nonce, r } = await c.cashOut(p, p.publicKey, D, fault);
    const t0 = Date.now();
    const committed = await c.waitFor(() => c.committedPending(p.publicKey, nonce).then((x) => x || null), 60_000, 500);
    const tCommit = committed ? Date.now() - t0 : null;
    await sleep(6_000);
    const receipt = await c.receipt(p.publicKey, nonce);
    const l1Sigs = await c.l1.getSignaturesForAddress(pda.ledger(p.publicKey), { limit: 10 });
    const er = await c.ledger(p.publicKey, "ER");
    trials.push({
      i, fault, nonce, er_sig: r.sig, er_ok: r.ok, er_err: r.err, debited_in_er: er?.ring.some((s) => s.nonce === nonce),
      commit_landed_on_l1: !!committed, ms_to_commit: tCommit, receipt_exists: !!receipt, receipt_path: receipt?.path ?? null,
      recent_l1_sigs_for_ledger: l1Sigs.map((s) => ({ sig: s.signature, err: s.err })),
    });
    recordEvidence({ campaign: "S1", step: fault ? "fault_trial" : "success_trial", layer: "ER", sig: r.sig, ok: r.ok, notes: JSON.stringify({ committed: !!committed, receipt: !!receipt }) });
    if (fault) await c.ensurePaid(p.publicKey, nonce, p); // leave nothing owed
  }
  const faults = (trials as { fault: boolean; commit_landed_on_l1: boolean; receipt_exists: boolean; debited_in_er: boolean; er_ok: boolean }[]).filter((t) => t.fault);
  const outcome = faults.every((t) => t.er_ok && t.debited_in_er && t.commit_landed_on_l1 && !t.receipt_exists) ? "dropped + recommitted (commit lands without the action)"
    : faults.every((t) => !t.er_ok) ? "reverted in the ER (nothing debited)"
    : faults.some((t) => t.er_ok && !t.commit_landed_on_l1) ? "reverted + stuck (debited, no commit) — request_commit path required"
    : "mixed — see trials";
  save("s1", { outcome, trials });
}

/** S2: how fast does the ER see a freshly created L1 account (deposit receipt)? */
async function s2(c: LandedClient) {
  const p = await player(c, admin, "s2-player", 10);
  const ms: number[] = [];
  const trials = N ?? 20;
  for (let i = 0; i < trials; i++) {
    const meta = await c.userMeta(p.publicKey);
    const n = meta!.depositCount;
    await c.mustSend("L1", [ix.deposit(c.a, p.publicKey, n, D / 10n)], [p], "s2_deposit");
    const t0 = Date.now();
    let ok = false;
    while (Date.now() - t0 < 30_000) {
      const r = await c.send("ER", [ix.ingestDeposit(p.publicKey, n)], [p], "s2_ingest");
      if (r.ok) { ok = true; break; }
      await sleep(300);
    }
    ms.push(ok ? Date.now() - t0 : -1);
  }
  const good = ms.filter((x) => x >= 0);
  save("s2", { trials, visible: good.length, p50_ms: pct(good, 50), p95_ms: pct(good, 95), max_ms: Math.max(...good), samples_ms: ms });
}

/** S3/C4: commit cap — 30 cash-outs on Landed (fee payer) vs 11 on the naive baseline (user pays). */
async function s3(c: LandedClient) {
  const p = await player(c, admin, "c4-player", 50, 0.05);
  const landed: { i: number; ok: boolean; paid: boolean; sig: string }[] = [];
  for (let i = 0; i < (N ?? 30); i++) {
    const { nonce, r } = await c.cashOut(p, p.publicKey, D);
    const rec = await c.waitFor(() => c.receipt(p.publicKey, nonce), 30_000, 500);
    landed.push({ i: i + 1, ok: r.ok, paid: !!rec, sig: r.sig });
    if (rec) await c.send("ER", [ix.ackWithdrawal(p.publicKey, nonce)], [p], "ack");
    if (!rec) await c.ensurePaid(p.publicKey, nonce, p);
  }
  const q = await naivePlayer(c, "c4-naive", 30);
  const naive: { i: number; ok: boolean; err?: string; sig: string }[] = [];
  for (let i = 0; i < 11; i++) {
    const r = await c.send("ER", [naiveIx.cashOut(q.publicKey, D, false)], [q], "naive_cash_out");
    naive.push({ i: i + 1, ok: r.ok, err: r.err, sig: r.sig });
  }
  save("c4", { landed_success: landed.filter((x) => x.ok && x.paid).length, landed, naive, naive_11th: naive[10] });
}

async function naivePlayer(c: LandedClient, label: string, fundD: number) {
  const q = await player(c, admin, label, 10, 0.05);
  const nl = await c.l1.getAccountInfo(naivePda.ledger(q.publicKey));
  if (!nl) {
    await c.mustSend("L1", [naiveIx.fund(q.publicKey, c.a.mint, BigInt(fundD) * D), naiveIx.delegateLedger(q.publicKey), ix.topUpEscrow(q.publicKey, q.publicKey, 20_000_000n)], [q], "naive_fund_delegate");
    await c.waitFor(async () => !!(await c.er.getAccountInfo(naivePda.ledger(q.publicKey))), 30_000, 500);
  }
  return q;
}

/** S5/C2: VRF latency + rounds. */
async function rounds(c: LandedClient, count: number, tag: string) {
  const ps = await Promise.all([0, 1, 2].map((i) => player(c, admin, `${tag}-p${i}`, 60)));
  const vrfMs: number[] = [];
  const closedBy: Record<string, number> = {};
  for (let r = 0; r < count; r++) {
    for (const [i, p] of ps.entries()) {
      if (i === 2 && r % 2) continue;
      await c.enter(p, p.publicKey, D * BigInt(1 + ((r + i) % 3)));
    }
    let t = await c.table("ER");
    const rid = t!.roundId;
    while (t && t.status === TABLE_STATUS.OPEN && t.roundId === rid) { await sleep(1000); await c.tick(ps[0]); t = await c.table("ER"); }
    const tClose = Date.now();
    closedBy[String(t?.closedBy)] = (closedBy[String(t?.closedBy)] ?? 0) + 1;
    const drawn = await c.waitFor(async () => { const x = await c.table("ER"); if (x && (x.status === TABLE_STATUS.DRAWN || x.roundId !== rid)) return x; await c.tick(ps[0]); return null; }, 200_000, 500);
    if (drawn) vrfMs.push(Date.now() - tClose);
    await c.waitFor(async () => { const x = await c.table("ER"); if (x && x.roundId !== rid) return x; await c.tick(ps[0]); return null; }, 30_000, 500);
    console.log(`round ${rid} done, vrf ${vrfMs[vrfMs.length - 1]} ms`);
  }
  const t = await c.table("ER");
  save(tag, { rounds: count, vrf_p50_ms: pct(vrfMs, 50), vrf_p95_ms: pct(vrfMs, 95), vrf_samples: vrfMs, closed_by: closedBy, table: { closes_by_crank: t?.closesByCrank, closes_by_keeper: t?.closesByKeeper, stale: t?.staleCallbacks, retries: t?.vrfRetries, voided: t?.roundsVoided, settled: t?.roundsSettled, last_crank_ts: t?.lastCrankTs } });
}

/** S7: a session signer with 0 lamports pays (nothing) for ER transactions. */
async function s7(c: LandedClient) {
  const p = await player(c, admin, "s7-owner", 20);
  const s = Keypair.generate();
  const exp = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const { token, ix: cs } = ix.createSessionV2(p.publicKey, s.publicKey, p.publicKey, exp);
  const r1 = await c.send("L1", [cs], [p, s], "create_session_v2");
  const r2 = await c.send("ER", [ix.setSession(p.publicKey, s.publicKey, 10n * D, exp)], [p], "set_session");
  await sleep(2000);
  const r3 = await c.send("ER", [ix.enterRound(c.a, s.publicKey, p.publicKey, D, token)], [s], "session_enter");
  save("s7", { session_signer_lamports: await c.l1.getBalance(s.publicKey), create_session_v2: r1, set_session: r2, session_signed_enter: r3 });
}

/** S8: committed ledger on L1 matches the ER after a commit. */
async function s8(c: LandedClient) {
  const p = await player(c, admin, "s1-player", 20);
  const { nonce } = await c.cashOut(p, p.publicKey, D);
  await c.waitFor(() => c.receipt(p.publicKey, nonce), 30_000, 500);
  const [er, l1, info] = await Promise.all([c.ledger(p.publicKey, "ER"), c.ledger(p.publicKey, "L1"), c.l1.getAccountInfo(pda.ledger(p.publicKey))]);
  save("s8", { l1_owner: info?.owner.toBase58(), er_available: er?.available, l1_available: l1?.available, er_nonce: er?.withdrawNonce, l1_nonce: l1?.withdrawNonce, match: er?.withdrawNonce === l1?.withdrawNonce });
}

/** C1: fresh guests end to end; time to first drop. */
async function c1(c: LandedClient) {
  const n = N ?? 20;
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const g = Keypair.generate();
    await fund(c, admin, g.publicKey, 0.02);
    const t0 = Date.now();
    await c.onboard(g, 50n * D);
    const r = await c.enter(g, g.publicKey, D);
    if (r.ok) ms.push(Date.now() - t0);
    console.log(`guest ${i}: ${Date.now() - t0} ms`);
  }
  save("c1", { guests: n, succeeded: ms.length, p50_ms: pct(ms, 50), p95_ms: pct(ms, 95), samples_ms: ms, note: "excludes the gas top-up transfer; measured from first onboarding tx to first confirmed drop" });
}

/** C3: N withdrawals with injected faults on Landed vs the same faults on the naive baseline. */
async function c3(c: LandedClient) {
  const total = N ?? 100, faults = Math.round(total / 5);
  const p = await player(c, admin, "c3-player", 100, 0.1);
  const rows: { nonce: bigint; fault: boolean; path: string; rescue_ms: number | null }[] = [];
  for (let i = 0; i < total; i++) {
    const fault = i % 5 === 0 && rows.filter((r) => r.fault).length < faults;
    const led = await c.ledger(p.publicKey, "ER");
    if ((led?.available ?? 0n) < D) { await c.onboard(p, 50n * D).catch(() => null); }
    const { nonce, r } = await c.cashOut(p, p.publicKey, D / 2n, fault);
    if (!r.ok) { rows.push({ nonce, fault, path: `request_failed:${r.err}`, rescue_ms: null }); continue; }
    const t0 = Date.now();
    let rec = await c.waitFor(() => c.receipt(p.publicKey, nonce), fault ? 9_000 : 30_000, 500);
    let path = rec ? (rec.path === 1 ? "rescue" : "action") : "owed";
    let rescueMs: number | null = null;
    if (!rec) {
      const e = await c.ensurePaid(p.publicKey, nonce, wallet("c3-rescuer-stranger"));
      path = e.path;
      rescueMs = Date.now() - t0;
      rec = await c.receipt(p.publicKey, nonce);
    }
    rows.push({ nonce, fault, path, rescue_ms: rescueMs });
    await c.ackPaid(p.publicKey, p);
  }
  // Naive: the same number of faulty cash-outs
  const q = await naivePlayer(c, "c3-naive", 40);
  const naive: { ok: boolean; sig: string }[] = [];
  for (let i = 0; i < Math.min(faults, 9); i++) naive.push(await c.send("ER", [naiveIx.cashOut(q.publicKey, D, true)], [q], "naive_fault_cash_out"));
  await sleep(15_000);
  const nv = await c.l1.getAccountInfo(naivePda.vault());
  const rescued = rows.filter((r) => r.path === "rescue");
  save("c3", {
    landed: { withdrawals: rows.length, paid: rows.filter((r) => r.path === "action" || r.path === "rescue").length, via_rescue: rescued.length, injected: rows.filter((r) => r.fault).length,
      owed_left: rows.filter((r) => r.path === "owed" || r.path === "pending").length, rescue_p50_ms: pct(rescued.map((r) => r.rescue_ms!), 50), rescue_p95_ms: pct(rescued.map((r) => r.rescue_ms!), 95) },
    naive: { faulty_cashouts: naive.length, accepted_in_er: naive.filter((x) => x.ok).length, vault_after: nv ? new DataView(nv.data.buffer, nv.data.byteOffset).getBigUint64(64, true) : null, sigs: naive.map((x) => x.sig) },
    rows,
  });
  await verify("after-c3");
}

async function main() {
  const c = client(id.toUpperCase());
  const bal = await c.l1.getBalance(admin.publicKey);
  console.log(`admin ${admin.publicKey.toBase58()} balance ${bal / 1e9} SOL`);
  if (bal < 0.2e9 && id !== "help") throw new Error("deployer wallet has < 0.2 devnet SOL — fund it first (faucet.solana.com)");
  switch (id) {
    case "s1": return s1(c);
    case "s2": return s2(c);
    case "s3": case "c4": return s3(c);
    case "s5": return rounds(c, N ?? 10, "s5");
    case "s7": return s7(c);
    case "s8": return s8(c);
    case "c1": return c1(c);
    case "c2": return rounds(c, N ?? 60, "c2");
    case "c3": return c3(c);
    case "c7": return verify(`manual-${Date.now()}`);
    case "all":
      for (const f of [s1, s2, s7, s8]) await f(c);
      await s3(c); await rounds(c, 10, "s5"); await c1(c); await c3(c); await rounds(c, 60, "c2"); await verify("final");
      return;
    default:
      console.log("usage: campaigns.ts <s1|s2|s3|s5|s7|s8|c1|c2|c3|c4|c7|all> [--n N]");
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
export { CLOSED_BY, SLOT_STATE, ata, PublicKey };
