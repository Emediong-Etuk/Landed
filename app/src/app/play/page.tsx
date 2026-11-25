"use client";
import { WalletShell } from "@/components/WalletShell";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { CHIPS, ONE_DUSDC, fmtD } from "@landed/sdk";
import { useApp } from "@/lib/store";
import { useBalances, useBots, useNow, useTable } from "@/lib/hooks";
import { cashOut, drop, playAsGuest, resumeOps, watchdogTick } from "@/lib/actions";
import { loadGuest } from "@/lib/guest";
import { PotRing } from "@/components/PotRing";
import { Balances } from "@/components/Balances";
import { SettlementRail } from "@/components/Rail";
import { Feed } from "@/components/Feed";
import { JoinPanel } from "@/components/Join";

export default function PlayPageRoute() {
  return <WalletShell><PlayPage /></WalletShell>;
}

function PlayPage() {
  const { ready, owner, latencies, technical } = useApp();
  const { data: table, isError } = useTable();
  const { data: bal } = useBalances(owner);
  const bots = useBots();
  const now = useNow(250);
  const [pending, setPending] = useState<number | null>(null);

  // Returning guests resume automatically (state comes from chain, not localStorage).
  useEffect(() => {
    if (ready) return;
    const q = new URLSearchParams(window.location.search);
    if (q.get("guest") === "1") { void playAsGuest(); return; }
    void loadGuest().then((kp) => { if (kp) void playAsGuest(); });
  }, [ready]);
  useEffect(() => { if (ready) void resumeOps(); }, [ready]);

  // Page-side watchdog: works even if our keeper and the crank are both down.
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(() => void watchdogTick(), 1500);
    return () => clearInterval(t);
  }, [ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!ready || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      const i = ["1", "2", "3", "4"].indexOf(e.key);
      if (i >= 0) void onDrop(CHIPS[i]);
      if (e.key.toLowerCase() === "c") void onCashAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function onDrop(d: number) {
    setPending(d);
    await drop(d);
    setPending(null);
  }
  async function onCashAll() {
    const amt = bal?.rollup ?? 0n;
    if (amt >= ONE_DUSDC) await cashOut(amt);
  }

  const p50 = latencies.length ? [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <section aria-label="The Drop" className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h1 className="display text-2xl">The Drop</h1>
          <span className="num text-sm text-[var(--color-muted)]">
            round {table?.roundId.toString() ?? "…"}{technical && p50 !== null ? ` · your ER p50 ${p50} ms` : ""}
          </span>
        </div>
        {isError && <p className="card p-3 text-sm text-[var(--color-amber)]">Can't reach the rollup right now. Your funds are safe; cash-outs and rescues still work on Solana.</p>}
        <PotRing table={table} me={owner?.toBase58() ?? null} bots={bots} now={now} />
        <div data-tour="drops">
        {ready ? (
          <>
            <div className="grid grid-cols-4 gap-2" role="group" aria-label="Drop chips">
              {CHIPS.map((d, i) => (
                <motion.button key={d} whileTap={{ scale: 0.94, y: 2 }} className="btn btn-primary display !min-h-14 text-lg" disabled={pending !== null}
                  onClick={() => void onDrop(d)} aria-keyshortcuts={String(i + 1)} aria-label={`Drop ${d} dUSDC`}>
                  {d}
                </motion.button>
              ))}
            </div>
            <p className="text-center text-xs text-[var(--color-dim)]">Tap to drop · keys 1 2 3 4 · zero fees, no popups</p>
          </>
        ) : (
          <JoinPanel />
        )}
        </div>
        <Feed />
      </section>
      <aside className="flex flex-col gap-4" aria-label="Your money">
        <Balances owner={owner} />
        <div className="card p-4" data-tour="cashout">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-muted)]">Settlement rail</h2>
            <button className="btn btn-primary !min-h-10 !py-1.5 text-sm" disabled={!ready || (bal?.rollup ?? 0n) < ONE_DUSDC} onClick={() => void onCashAll()} aria-keyshortcuts="c">
              Cash out all{bal?.rollup ? ` ${fmtD(bal.rollup)}` : ""}
            </button>
          </div>
          <SettlementRail />
        </div>
      </aside>
    </div>
  );
}
