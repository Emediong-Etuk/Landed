"use client";
import { motion } from "motion/react";
import { fmtD, txUrl, short, type CashoutState } from "@landed/sdk";
import { useApp } from "@/lib/store";
import { rescue } from "@/lib/actions";

export function TxChip({ sig, layer }: { sig?: string; layer?: "L1" | "ER" }) {
  if (!sig || !layer) return null;
  return (
    <a href={txUrl(sig, layer)} target="_blank" rel="noreferrer"
      className={`num inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${layer === "L1" ? "chip-l1" : "chip-er"}`}>
      {layer === "L1" ? "Solana" : "Rollup"} {short(sig, 4)} ↗
    </a>
  );
}

const LABELS: Record<string, string> = {
  requested: "Requested (rollup)",
  commit_forced: "Commit forced",
  committed: "Committed (Solana)",
  action_dropped: "Payout action dropped",
  rescue_sent: "Rescue sent",
  paid: "Paid ✓",
  acked: "Slot released",
};

function tone(step: string) {
  if (step === "paid" || step === "acked") return "var(--color-mint)";
  if (step === "action_dropped" || step === "rescue_sent" || step === "commit_forced") return "var(--color-amber)";
  return "var(--color-signal)";
}

export function OpRail({ op }: { op: CashoutState }) {
  const technical = useApp((s) => s.technical);
  const mode = useApp((s) => s.mode);
  const steps = op.history.filter((h) => technical || h.step !== "acked");
  const t0 = op.requestedAt;
  const showRescue = mode === "wallet" && (op.step === "action_dropped" || op.step === "committed") && Date.now() - t0 > 8000;
  return (
    <li className="card p-3" aria-label={`Cash-out ${fmtD(op.amount)} dUSDC: ${LABELS[op.step]}`}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="num text-sm font-semibold">Cash out {fmtD(op.amount)} dUSDC</span>
        <span className="text-xs" style={{ color: tone(op.step) }}>
          {op.step === "paid" || op.step === "acked" ? (op.path === "rescue" ? "Landed (rescued)" : "Landed") : op.path === "rescue" || op.step === "rescue_sent" || op.step === "action_dropped" ? "Rescuing…" : "On the way…"}
        </span>
      </div>
      <ol className="relative ml-2 border-l hair pl-4">
        {steps.map((h, i) => (
          <motion.li key={h.step} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25, delay: i * 0.03 }} className="relative pb-2 last:pb-0">
            <span className="absolute -left-[22px] top-1 h-2.5 w-2.5 rounded-full" style={{ background: tone(h.step) }} aria-hidden />
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{LABELS[h.step] ?? h.step}</span>
              <span className="num text-[11px] text-[var(--color-dim)]">+{Math.max(0, h.at - t0)} ms</span>
              {technical && <TxChip sig={h.sig} layer={h.layer} />}
            </div>
          </motion.li>
        ))}
      </ol>
      {technical && <div className="num mt-2 text-[11px] text-[var(--color-dim)]">nonce {op.nonce.toString()}{op.fault ? " · fault-injected" : ""}</div>}
      {showRescue && <button className="btn btn-ghost mt-2 !min-h-9 w-full text-sm" onClick={() => void rescue(op)}>Rescue my payout</button>}
    </li>
  );
}

export function SettlementRail() {
  const ops = useApp((s) => s.ops);
  if (!ops.length) return <p className="text-sm text-[var(--color-muted)]">Cash-outs appear here with every step from the rollup to your Solana wallet.</p>;
  return <ul className="flex flex-col gap-2">{ops.map((o) => <OpRail key={`${o.owner}-${o.nonce}`} op={o} />)}</ul>;
}
