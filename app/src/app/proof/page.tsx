"use client";
import { useQuery } from "@tanstack/react-query";
import { LANDED_PROGRAM_ID, NAIVE_PROGRAM_ID, addressUrl, short, txUrl } from "@landed/sdk";
import { getClient } from "@/lib/chain";
import { useBots } from "@/lib/hooks";

interface Evidence {
  generated_at: string | null;
  deployed: boolean;
  featured: { label: string; sig: string; layer: "L1" | "ER" }[];
  campaigns: { id: string; txs: number; ok: number; p50_ms: number | null }[];
  metrics: { id: string; label: string; value: string; source: string }[];
  phase0: { id: string; title: string; finding: string }[];
  tests: { layer: string; tests: number; passed: number; failed: number }[];
  deployments: Record<string, unknown> | null;
}

function useEvidence() {
  return useQuery<Evidence>({ queryKey: ["evidence"], queryFn: () => fetch("/evidence.json").then((r) => r.json()) });
}
function useLive() {
  return useQuery({
    queryKey: ["proof-live"],
    queryFn: async () => {
      const c = getClient();
      const [t, l1sigs, ersigs] = await Promise.all([
        c.table("ER").catch(() => null),
        c.l1.getSignaturesForAddress(LANDED_PROGRAM_ID, { limit: 25 }).catch(() => []),
        c.er.getSignaturesForAddress(c.a.table, { limit: 25 }).catch(() => []),
      ]);
      return { t, l1sigs, ersigs };
    },
    refetchInterval: 10_000,
  });
}

export default function ProofPage() {
  const { data: ev } = useEvidence();
  const { data: live } = useLive();
  const bots = useBots();
  const t = live?.t;
  const txs = [
    ...(live?.l1sigs ?? []).map((s) => ({ ...s, layer: "L1" as const })),
    ...(live?.ersigs ?? []).map((s) => ({ ...s, layer: "ER" as const })),
  ].sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0)).slice(0, 50);

  return (
    <div className="flex flex-col gap-6" data-tour="proof">
      <header>
        <h1 className="display text-2xl">Proof</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">Every number here is read from chain or from a recorded test run in <code>evidence/</code>. Nothing is hard-coded.</p>
      </header>
      <section className="grid gap-3 md:grid-cols-2">
        {[["landed", LANDED_PROGRAM_ID.toBase58()], ["naive_cashout (baseline)", NAIVE_PROGRAM_ID.toBase58()]].map(([n, id]) => (
          <div key={id} className="card p-4">
            <div className="text-xs text-[var(--color-muted)]">{n} program (devnet)</div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <code className="num break-all text-sm">{id}</code>
              <button className="btn btn-ghost !min-h-8 !px-2 !py-0.5 text-xs" onClick={() => navigator.clipboard?.writeText(id)}>Copy</button>
              <a className="text-xs text-[var(--color-signal)] underline" href={addressUrl(id)} target="_blank" rel="noreferrer">Explorer ↗</a>
            </div>
          </div>
        ))}
      </section>
      {!ev?.deployed && (
        <p className="card p-4 text-sm text-[var(--color-amber)]">
          Not deployed to devnet yet: the deployer wallet is waiting for devnet SOL (the public RPC faucet is closed). Program logic is proven by the MagicSVM suite below; live numbers appear here as soon as the campaigns run.
        </p>
      )}
      <section className="card p-4">
        <h2 className="text-sm font-semibold text-[var(--color-muted)]">Read from chain now</h2>
        <dl className="num mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div><dt className="text-[var(--color-dim)]">VRF requests (table)</dt><dd>{t ? t.vrfNonce.toString() : "—"}</dd></div>
          <div><dt className="text-[var(--color-dim)]">Rounds settled / voided</dt><dd>{t ? `${t.roundsSettled} / ${t.roundsVoided}` : "—"}</dd></div>
          <div><dt className="text-[var(--color-dim)]">Stale callbacks ignored</dt><dd>{t ? t.staleCallbacks.toString() : "—"}</dd></div>
          <div><dt className="text-[var(--color-dim)]">Closed by crank / watchdog</dt><dd>{t ? `${t.closesByCrank} / ${t.closesByKeeper}` : "—"}</dd></div>
        </dl>
      </section>
      {!!ev?.featured?.length && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-[var(--color-muted)]">Featured transactions</h2>
          <ul className="mt-2 grid gap-1 text-sm">{ev.featured.map((f) => (
            <li key={f.sig} className="flex flex-wrap gap-2"><span className="w-56">{f.label}</span><a className="num underline" href={txUrl(f.sig, f.layer)} target="_blank" rel="noreferrer">{short(f.sig, 8)} ↗</a><span className="text-xs text-[var(--color-dim)]">{f.layer}</span></li>
          ))}</ul>
        </section>
      )}
      {!!ev?.metrics?.length && (
        <section tabIndex={0} aria-label="Scrollable table" className="card overflow-x-auto p-4">
          <h2 className="text-sm font-semibold text-[var(--color-muted)]">Measured results</h2>
          <table className="mt-2 w-full text-sm"><tbody>{ev.metrics.map((m) => <tr key={m.id} className="border-t hair"><td className="py-1.5 pr-3 text-[var(--color-dim)]">{m.id}</td><td className="pr-3">{m.label}</td><td className="num">{m.value}</td><td className="text-xs text-[var(--color-dim)]">{m.source}</td></tr>)}</tbody></table>
        </section>
      )}
      <section tabIndex={0} aria-label="Scrollable table" className="card overflow-x-auto p-4">
        <h2 className="text-sm font-semibold text-[var(--color-muted)]">Test report</h2>
        <table className="num mt-2 w-full text-sm">
          <thead className="text-left text-[var(--color-dim)]"><tr><th>Layer</th><th>Tests</th><th>Passed</th><th>Failed</th></tr></thead>
          <tbody>{(ev?.tests ?? []).map((r) => <tr key={r.layer} className="border-t hair"><td className="py-1">{r.layer}</td><td>{r.tests}</td><td className="text-[var(--color-mint)]">{r.passed}</td><td>{r.failed}</td></tr>)}</tbody>
        </table>
      </section>
      {!!ev?.phase0?.length && (
        <section className="card p-4">
          <h2 className="text-sm font-semibold text-[var(--color-muted)]">Phase 0 findings</h2>
          <ul className="mt-2 flex flex-col gap-2 text-sm">{ev.phase0.map((p) => <li key={p.id}><span className="num text-[var(--color-dim)]">{p.id}</span> <strong>{p.title}</strong> — {p.finding}</li>)}</ul>
        </section>
      )}
      <section className="card p-4">
        <h2 className="text-sm font-semibold text-[var(--color-muted)]">Latest transactions</h2>
        <ul className="num mt-2 flex flex-col gap-1 text-xs">
          {txs.map((s) => (
            <li key={s.signature} className="flex flex-wrap items-center gap-2">
              <span className={`rounded border px-1 ${s.layer === "L1" ? "chip-l1" : "chip-er"}`}>{s.layer === "L1" ? "Solana" : "Rollup"}</span>
              <a className="underline" href={txUrl(s.signature, s.layer)} target="_blank" rel="noreferrer">{short(s.signature, 10)}</a>
              <span className="text-[var(--color-dim)]">{s.blockTime ? new Date(s.blockTime * 1000).toLocaleTimeString() : ""}</span>
              {s.err ? <span className="text-[var(--color-danger)]">failed</span> : null}
            </li>
          ))}
          {!txs.length && <li className="text-[var(--color-dim)]">No transactions found yet.</li>}
        </ul>
      </section>
      <section className="card p-4 text-sm">
        <h2 className="text-sm font-semibold text-[var(--color-muted)]">Labeled bots</h2>
        <p className="mt-1 text-[var(--color-muted)]">Two bots keep a solo judge company. They are ours, funded from the faucet, and striped “BOT” in the ring.</p>
        <ul className="num mt-2 text-xs">{[...bots].map((b) => <li key={b}><a className="underline" href={addressUrl(b)} target="_blank" rel="noreferrer">{b}</a></li>)}</ul>
        {!bots.size && <p className="text-xs text-[var(--color-dim)]">Bot keys are published here once the keeper is deployed.</p>}
      </section>
    </div>
  );
}
