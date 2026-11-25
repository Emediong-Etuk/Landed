"use client";
import { WalletShell } from "@/components/WalletShell";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ONE_DUSDC, fmtD, ix, naiveIx, naivePda, decodeNLedger, eventsFromLogs, type CashoutState } from "@landed/sdk";
import { useApp } from "@/lib/store";
import { getClient } from "@/lib/chain";
import { cashOut, playAsGuest } from "@/lib/actions";
import { loadGuest } from "@/lib/guest";
import { OpRail, TxChip } from "@/components/Rail";
import { JoinPanel } from "@/components/Join";

interface NaiveRun { id: number; at: number; amount: bigint; erSig?: string; erOk?: boolean; committedAt?: number; paid: boolean; checkedAt?: number; err?: string }
const AMOUNT = 10n * ONE_DUSDC;

export default function LabPageRoute() {
  return <WalletShell><LabPage /></WalletShell>;
}

function LabPage() {
  const { ready, owner, actor, ops, mode } = useApp();
  const [naiveReady, setNaiveReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [naiveRuns, setNaiveRuns] = useState<NaiveRun[]>([]);
  const [landedNonces, setLandedNonces] = useState<bigint[]>([]);

  useEffect(() => { if (!ready) void loadGuest().then((k) => k && playAsGuest()); }, [ready]);
  useEffect(() => {
    if (!owner) return;
    void getClient().er.getAccountInfo(naivePda.ledger(owner)).then((a) => setNaiveReady(!!a)).catch(() => setNaiveReady(false));
  }, [owner]);

  async function openNaive() {
    if (!actor || !owner) return;
    setBusy(true);
    const c = getClient();
    const r = await c.send("L1", [naiveIx.fund(owner, c.a.mint, 30n * ONE_DUSDC), naiveIx.delegateLedger(owner), ix.topUpEscrow(owner, owner, 20_000_000n)], [actor], "naive_fund");
    if (!r.ok) useApp.getState().set({ error: { message: "Couldn't open the baseline account (it needs 30 dUSDC in your Solana wallet)." } });
    else await c.waitFor(async () => !!(await c.er.getAccountInfo(naivePda.ledger(owner))), 30_000, 600).then((x) => setNaiveReady(!!x));
    setBusy(false);
  }

  async function breakBoth() {
    if (!actor || !owner) return;
    setBusy(true);
    const c = getClient();
    const before = (await c.ledger(owner, "ER"))?.withdrawNonce ?? 0n;
    const id = Date.now();
    const run: NaiveRun = { id, at: Date.now(), amount: AMOUNT, paid: false };
    setNaiveRuns((x) => [run, ...x]);
    const [, nr] = await Promise.all([
      cashOut(AMOUNT, true),
      naiveReady ? c.send("ER", [naiveIx.cashOut(owner, AMOUNT, true)], [actor], "naive_cash_out") : Promise.resolve(null),
    ]);
    setLandedNonces((x) => [before, ...x]);
    if (nr) {
      setNaiveRuns((x) => x.map((r) => (r.id === id ? { ...r, erSig: nr.sig, erOk: nr.ok, err: nr.ok ? undefined : nr.err } : r)));
      // Watch the naive ledger's committed copy on L1, and look for a NaivePaid event (there won't be one).
      void (async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < 25_000) {
          const a = await c.l1.getAccountInfo(naivePda.ledger(owner)).catch(() => null);
          const l = a ? decodeNLedger(new Uint8Array(a.data)) : null;
          if (l && l.requestedTotal > 0n) { setNaiveRuns((x) => x.map((r) => (r.id === id && !r.committedAt ? { ...r, committedAt: Date.now() } : r))); }
          await new Promise((s) => setTimeout(s, 1000));
        }
        const sigs = await c.l1.getSignaturesForAddress(naivePda.vault(), { limit: 10 }).catch(() => []);
        const txs = await Promise.all(sigs.filter((s) => (s.blockTime ?? 0) * 1000 >= t0 - 5000).map((s) => c.l1.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null)));
        const paid = txs.some((t) => (t?.meta?.logMessages ?? []).some((m) => m.includes("NaivePaid") || m.includes("Instruction: NaivePayout")) && !t?.meta?.err);
        setNaiveRuns((x) => x.map((r) => (r.id === id ? { ...r, paid, checkedAt: Date.now() } : r)));
      })();
    }
    setBusy(false);
  }

  const landedOps = ops.filter((o) => o.fault && landedNonces.includes(o.nonce));
  const rescued = landedOps.filter((o) => o.step === "paid" || o.step === "acked");
  const stranded = naiveRuns.filter((r) => r.checkedAt && !r.paid && r.erOk);
  void eventsFromLogs;

  if (!ready) return <div className="mx-auto max-w-lg pt-6"><JoinPanel /></div>;

  return (
    <div className="flex flex-col gap-5" data-tour="lab">
      <header>
        <h1 className="display text-2xl">Fault Lab</h1>
        <p className="mt-2 max-w-3xl text-sm text-[var(--color-muted)]">
          One button sends a <strong>real</strong> devnet cash-out whose post-commit payout action fails on purpose (a devnet-only flag that affects only your own withdrawal).
          Left: the documented commit + post-commit-payout pattern. Right: Landed. Same failure, different outcome.
        </p>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        {naiveReady === false && <button className="btn btn-ghost" disabled={busy} onClick={() => void openNaive()}>Open a baseline account (30 dUSDC)</button>}
        <button className="btn btn-primary" disabled={busy || naiveReady === null} onClick={() => void breakBoth()}>
          Cash out 10 dUSDC with a failing payout
        </button>
        {mode === "wallet" && <span className="text-xs text-[var(--color-dim)]">Wallet users click “Rescue my payout” on the right (or wait for the keeper).</span>}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-4" aria-label="Naive baseline">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="display text-lg">Naive baseline</h2>
            <span className="text-xs text-[var(--color-dim)]">no receipt · no rescue</span>
          </div>
          <Meter label="Stranded this session" value={stranded.reduce((a, r) => a + r.amount, 0n)} tone="var(--color-danger)" />
          <ul className="mt-3 flex flex-col gap-2">
            {naiveRuns.map((r) => (
              <li key={r.id} className="rounded-xl border hair p-3 text-sm">
                <Step ok label="Requested in rollup (debited)" sig={r.erSig} layer="ER" />
                {r.erOk === false && <p className="text-[var(--color-amber)]">ER rejected it: {r.err?.slice(0, 80)}</p>}
                {r.committedAt && <Step ok label="Committed on Solana" />}
                {r.checkedAt ? (r.paid ? <Step ok label="Paid" /> : <p className="mt-1 text-[var(--color-danger)]">Action dropped. Payout never arrived — {fmtD(r.amount)} dUSDC stranded, nothing anyone can call.</p>)
                  : <p className="mt-1 text-[var(--color-dim)]">waiting for a payout…</p>}
              </li>
            ))}
            {!naiveRuns.length && <li className="text-sm text-[var(--color-dim)]">No runs yet.</li>}
          </ul>
        </section>
        <section className="card p-4" aria-label="Landed">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="display text-lg text-[var(--color-mint)]">Landed</h2>
            <span className="text-xs text-[var(--color-dim)]">exactly-once · rescuable</span>
          </div>
          <Meter label="Rescued this session" value={rescued.reduce((a, o) => a + o.amount, 0n)} tone="var(--color-mint)" />
          <ul className="mt-3 flex flex-col gap-2">{landedOps.map((o: CashoutState) => <OpRail key={o.nonce.toString()} op={o} />)}</ul>
          {!landedOps.length && <p className="mt-3 text-sm text-[var(--color-dim)]">No runs yet.</p>}
        </section>
      </div>
      <section className="card overflow-x-auto p-4">
        <h2 className="mb-2 text-sm font-semibold text-[var(--color-muted)]">Results this session</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-[var(--color-dim)]"><tr><th className="py-1">Pattern</th><th>Failing payouts</th><th>Paid</th><th>Lost</th></tr></thead>
          <tbody className="num">
            <tr><td className="py-1">Naive baseline</td><td>{naiveRuns.length}</td><td>{naiveRuns.filter((r) => r.paid).length}</td><td className="text-[var(--color-danger)]">{stranded.length} ({fmtD(stranded.reduce((a, r) => a + r.amount, 0n))})</td></tr>
            <tr><td className="py-1">Landed</td><td>{landedOps.length}</td><td className="text-[var(--color-mint)]">{rescued.length}</td><td>0</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Meter({ label, value, tone }: { label: string; value: bigint; tone: string }) {
  return (
    <div>
      <div className="flex justify-between text-xs text-[var(--color-muted)]"><span>{label}</span><span className="num" style={{ color: tone }}>{fmtD(value)} dUSDC</span></div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--color-hairline)]">
        <motion.div className="h-full" style={{ background: tone }} animate={{ width: `${Math.min(100, Number(value) / 1e6 * 2)}%` }} />
      </div>
    </div>
  );
}
function Step({ ok, label, sig, layer }: { ok: boolean; label: string; sig?: string; layer?: "L1" | "ER" }) {
  return <div className="flex flex-wrap items-center gap-2"><span aria-hidden>{ok ? "•" : "×"}</span><span>{label}</span><TxChip sig={sig} layer={layer} /></div>;
}
