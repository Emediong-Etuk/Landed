"use client";
import NumberFlow from "@number-flow/react";
import type { PublicKey } from "@solana/web3.js";
import { useBalances } from "@/lib/hooks";

function Row({ label, value, hint, color }: { label: string; value: bigint; hint: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5" title={hint}>
      <span className="text-sm text-[var(--color-muted)]">{label} <span className="sr-only">— {hint}</span></span>
      <span className="num text-lg font-semibold" style={{ color }}>
        <NumberFlow value={Number(value) / 1e6} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} /> <span className="text-xs text-[var(--color-dim)]">dUSDC</span>
      </span>
    </div>
  );
}

/** The two truths: rollup state vs Solana state, plus what's in flight between them. */
export function Balances({ owner }: { owner: PublicKey | null }) {
  const { data } = useBalances(owner);
  return (
    <div className="card p-4" data-tour="balances">
      <Row label="Playable in rollup" value={data?.rollup ?? 0n} hint="Lives in the Ephemeral Rollup: instant, free, spendable on the next drop." />
      <Row label="In your wallet on Solana" value={data?.wallet ?? 0n} hint="Real SPL tokens on Solana devnet that you own." color="var(--color-mint)" />
      <Row label="On the way" value={data?.onTheWay ?? 0n} hint="Debited in the rollup, not yet paid on Solana. Landed guarantees it lands — or anyone can rescue it." color={data?.onTheWay ? "var(--color-amber)" : undefined} />
    </div>
  );
}
