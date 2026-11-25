"use client";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { cfg } from "@/lib/config";

interface Check { id: string; title: string; status: "pass" | "fail" | "warn" | "skip"; detail: string }
interface Report { generatedAt: string; summary: { pass: number; fail: number; warn: number; skip: number; ok: boolean }; checks: Check[]; counts: Record<string, unknown>; notes: string[] }
interface Round { roundId: string; entries: { player: string; amount: string }[]; closedEntriesHash?: string; drawn?: { randomness: string; vrfNonce: string; sig: string; viaVrfProgram: boolean }; settled?: { winner: string; pot: string; fee: string; sig: string } }

const COLOR = { pass: "var(--color-mint)", fail: "var(--color-danger)", warn: "var(--color-amber)", skip: "var(--color-dim)" } as const;
const PLACEHOLDER = ["I1", "I2", "I3", "I4", "I5", "I6", "F3", "F4", "N1"];

export default function VerifyPage() {
  const [log, setLog] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [round, setRound] = useState<string | null>(null);
  const w = useRef<Worker | null>(null);

  function run() {
    setRunning(true); setReport(null); setErr(null); setLog([]);
    w.current?.terminate();
    const worker = new Worker(new URL("./verifier.worker.ts", import.meta.url), { type: "module" });
    w.current = worker;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") setLog((l) => [...l, m.msg]);
      if (m.type === "done") { setReport(m.report); setRounds(m.rounds); setRunning(false); }
      if (m.type === "error") { setErr(m.message); setRunning(false); }
    };
    worker.postMessage({ l1Url: `${location.origin}${cfg.l1Path}`, erUrl: cfg.erUrl });
  }
  useEffect(() => {
    setRound(new URLSearchParams(location.search).get("round"));
    run();
    return () => w.current?.terminate();
  }, []);

  function download() {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `landed-verify-${Date.now()}.json`;
    a.click();
  }

  const focus = round ? rounds.find((r) => r.roundId === round) : null;
  return (
    <div className="flex flex-col gap-5" data-tour="verify">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display text-2xl">Verify</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">Runs in a Web Worker in your browser, reading Solana devnet and the MagicBlock rollup directly. It never asks our backend for an answer.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary" disabled={running} onClick={run}>{running ? "Verifying…" : "Run again"}</button>
          <button className="btn btn-ghost" disabled={!report} onClick={download}>Download JSON</button>
        </div>
      </header>
      {err && <div className="card p-4 text-sm"><span className="text-[var(--color-amber)]">Couldn&apos;t fetch chain data:</span> {err}</div>}
      <ol className="flex flex-col gap-2">
        {(report?.checks ?? PLACEHOLDER.map((id) => ({ id, title: "", status: "skip" as const, detail: "" }))).map((c, i) => (
          <motion.li key={c.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }} className="card p-0">
            <details>
              <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
                <span className="num w-10 text-sm text-[var(--color-dim)]">{c.id}</span>
                <span className="flex-1 text-sm">{report ? c.title : running ? "checking…" : "—"}</span>
                {report && <span className="rounded-md px-2 py-0.5 text-xs font-semibold uppercase" style={{ color: COLOR[c.status], border: `1px solid ${COLOR[c.status]}` }}>
                  {c.id === "N1" && c.status === "fail" ? "stranded (expected)" : c.status}
                </span>}
              </summary>
              {report && <p className="num border-t hair px-4 py-3 text-xs text-[var(--color-muted)]">{c.detail}</p>}
            </details>
          </motion.li>
        ))}
      </ol>
      {report && (
        <p className="text-sm">
          <span style={{ color: report.checks.some((c) => c.status === "fail" && c.id !== "N1") ? COLOR.fail : COLOR.pass }}>
            {report.checks.some((c) => c.status === "fail" && c.id !== "N1") ? "Violation found." : "Landed: all invariants hold."}
          </span>{" "}
          <span className="text-[var(--color-muted)]">{report.summary.pass} pass · {report.summary.warn} warn · {report.summary.skip} skip · generated {new Date(report.generatedAt).toLocaleTimeString()}</span>
        </p>
      )}
      {focus && (
        <section className="card p-4">
          <h2 className="display text-lg">Round {focus.roundId}</h2>
          <p className="num mt-2 break-all text-xs text-[var(--color-muted)]">randomness {focus.drawn?.randomness} · nonce {focus.drawn?.vrfNonce} · via VRF program: {String(focus.drawn?.viaVrfProgram)}</p>
          <ul className="num mt-2 text-xs">{focus.entries.map((e) => <li key={e.player}>{e.player} — {(Number(e.amount) / 1e6).toFixed(2)}{e.player === focus.settled?.winner ? "  ← winner" : ""}</li>)}</ul>
        </section>
      )}
      <section className="card p-4">
        <h2 className="text-sm font-semibold text-[var(--color-muted)]">Run it yourself</h2>
        <pre tabIndex={0} aria-label="Commands to run the verifier yourself" className="num mt-2 overflow-x-auto rounded-lg bg-[var(--color-ink)] p-3 text-xs">{`git clone ${cfg.repo} && cd landed
pnpm i && pnpm verify:devnet          # exit 0 = all pass, 1 = violation, 2 = couldn't fetch
pnpm verify:devnet -- --json out.json  # machine-readable report`}</pre>
      </section>
      {running && <ul aria-live="polite" className="num text-xs text-[var(--color-dim)]">{log.map((l, i) => <li key={i}>… {l}</li>)}</ul>}
      {report?.notes?.length ? <ul className="text-xs text-[var(--color-dim)]">{report.notes.map((n) => <li key={n}>note: {n}</li>)}</ul> : null}
    </div>
  );
}
