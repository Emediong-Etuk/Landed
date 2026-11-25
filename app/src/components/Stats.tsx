"use client";
import NumberFlow, { type Format } from "@number-flow/react";
import { useStats } from "@/lib/stats";

function Tile({ label, value, suffix, tone, format }: { label: string; value: number | null | undefined; suffix?: string; tone?: string; format?: Format }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs text-[var(--color-muted)]">{label}</div>
      <div className="num mt-1 text-2xl font-semibold" style={{ color: tone }}>
        {value === null || value === undefined ? <span className="text-[var(--color-dim)]">—</span> : <NumberFlow value={value} format={format} />}
        {suffix && value !== null && value !== undefined && <span className="ml-1 text-sm text-[var(--color-dim)]">{suffix}</span>}
      </div>
    </div>
  );
}

export function LiveStats() {
  const { data, isLoading } = useStats();
  return (
    <section aria-label="Live chain stats" data-tour="stats">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Tile label="Rounds settled" value={data?.roundsSettled} />
        <Tile label="Total paid out" value={data?.totalPaidD} suffix="dUSDC" format={{ maximumFractionDigits: 0 }} />
        <Tile label="Owed > 60 s" value={data?.owedOver60s} tone={data?.owedOver60s ? "var(--color-danger)" : "var(--color-mint)"} />
        <Tile label="ER entry p50" value={data?.erP50Ms} suffix="ms" />
        <Tile label="Closed by crank" value={data?.crankPct} suffix="%" format={{ maximumFractionDigits: 0 }} />
      </div>
      <p className="mt-2 text-xs text-[var(--color-dim)]">
        {isLoading ? "Reading devnet…" : data?.deployed ? `Read from devnet accounts · ${new Date(data.asOf).toLocaleTimeString()}` : data?.note ?? "Waiting for the devnet deployment."}
      </p>
    </section>
  );
}
